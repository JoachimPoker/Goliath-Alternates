// supabase/functions/send-alt-alerts/index.ts
//
// Triggered by a Supabase Database Webhook on UPDATE of the tournaments
// table (see setup instructions). Checks whether the change - either
// the calling number moving, or the status itself changing - means
// someone should be notified, and if so, sends them a real push
// notification. This works even with their browser fully closed, since
// delivery goes through the browser vendor's own push service
// (Apple/Google), not a live connection to this site.
//
// How each status is handled:
//   OPEN (Immediate Seating) / ALL (All Alternates) - seating is open
//     to everyone waiting, not tied to a specific number, so every
//     not-yet-notified subscriber for this event gets alerted the
//     moment either of these is set, regardless of their own number.
//   BATCH (Alts Up To X) / BREAK (After Break Up To X) - both are a
//     genuine numbered queue, so the usual "your number's been reached
//     or passed" comparison applies.
//
// Deploy with:
//   supabase functions deploy send-alt-alerts
//
// Needs these secrets set first (see setup instructions):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_CONTACT_EMAIL=...

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Alert threshold for numbered statuses (BATCH/BREAK): fires once the
// calling number reaches or passes someone's own number - no early
// warning buffer. Set this above 0 if you ever want a "getting close"
// heads-up instead (e.g. 5 means alerted once calling is within 5 of
// their number). Doesn't apply to OPEN/ALL, which always notify
// everyone regardless of number.
const ALERT_BUFFER = 0;

Deno.serve(async (req) => {
  try {
    const payload = await req.json();

    // Direct test call from the admin panel's "Send Me a Test Alert"
    // button - a completely separate path from the real webhook flow
    // below, so it can never touch real subscriber data or send
    // anything to a real player.
    if (payload.type === "TEST") {
      console.log("Test alert requested");
      webpush.setVapidDetails(
        `mailto:${Deno.env.get("VAPID_CONTACT_EMAIL") ?? "admin@example.com"}`,
        Deno.env.get("VAPID_PUBLIC_KEY")!,
        Deno.env.get("VAPID_PRIVATE_KEY")!
      );
      try {
        await webpush.sendNotification(payload.subscription, JSON.stringify({
          title: "Test Alert",
          body: "If you see this, your Alert Me pipeline is working correctly!",
          tag: "goliath-test-alert"
        }));
        console.log("Test alert sent OK");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      } catch (err) {
        console.error("Test alert failed:", err);
        return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
      }
    }

    if (payload.type !== "UPDATE") {
      console.log("Ignored: not an UPDATE event");
      return new Response("ignored (not an update)", { status: 200 });
    }

    const record = payload.record;
    const oldRecord = payload.old_record;

    const numberChanged = record?.current_alt_number !== oldRecord?.current_alt_number;
    const statusChanged = record?.status_mode !== oldRecord?.status_mode;

    if (!record || (!numberChanged && !statusChanged)) {
      console.log("Ignored: neither the alt number nor the status changed", { id: record?.id });
      return new Response("ignored (nothing relevant changed)", { status: 200 });
    }

    console.log(`Tournament ${record.id} (${record.name}) changed: alt ${oldRecord?.current_alt_number} -> ${record.current_alt_number}, status ${oldRecord?.status_mode} -> ${record.status_mode}`);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Respect the admin on/off switch - if alerts are disabled, do
    // nothing at all, even if subscriptions exist.
    const { data: settings } = await supabaseAdmin
      .from("site_settings")
      .select("alerts_enabled")
      .eq("id", 1)
      .maybeSingle();

    if (settings && settings.alerts_enabled === false) {
      console.log("Ignored: alerts are disabled in admin");
      return new Response("ignored (alerts disabled)", { status: 200 });
    }

    const currentNum = record.current_alt_number;
    const seatingWideOpen = record.status_mode === "OPEN" || record.status_mode === "ALL";

    let query = supabaseAdmin
      .from("push_subscriptions")
      .select("*")
      .eq("tournament_id", record.id)
      .eq("notified", false);

    // Only filter by number for the two numbered statuses - for
    // OPEN/ALL, everyone still waiting gets notified, no number check.
    if (!seatingWideOpen) {
      query = query.lte("target_alt_number", currentNum + ALERT_BUFFER);
    }

    const { data: subs, error } = await query;

    if (error) {
      console.error("Error querying push_subscriptions:", error);
      throw error;
    }

    console.log(`Found ${subs?.length ?? 0} matching subscription(s) (seatingWideOpen=${seatingWideOpen}, currentNum=${currentNum})`);

    if (!subs || subs.length === 0) {
      return new Response("no matching subscriptions", { status: 200 });
    }

    webpush.setVapidDetails(
      `mailto:${Deno.env.get("VAPID_CONTACT_EMAIL") ?? "admin@example.com"}`,
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!
    );

    const results = await Promise.allSettled(
      subs.map((sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        // Each person's message is personalized to their own number,
        // except for OPEN/ALL where there's no number to reference.
        const body = seatingWideOpen
          ? `Seating is open now for ${record.name} - head to the desk!`
          : `Now calling #${currentNum} - your number (#${sub.target_alt_number}) has been called. Head to the desk!`;
        const personalized = JSON.stringify({
          title: `${record.name}`,
          body,
          tag: `alt-${record.id}`
        });
        return webpush.sendNotification(pushSubscription, personalized);
      })
    );

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`Push failed for subscription ${subs[i].id}:`, r.reason);
      } else {
        console.log(`Push sent OK for subscription ${subs[i].id}`);
      }
    });

    // Mark everyone as notified regardless of individual delivery
    // success/failure - a dead/expired subscription shouldn't be
    // retried forever, and a real failure here just means that one
    // person doesn't get a second attempt, which is an acceptable
    // trade-off for keeping this simple.
    await supabaseAdmin
      .from("push_subscriptions")
      .update({ notified: true })
      .in("id", subs.map((s) => s.id));

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - sent;

    console.log(`Done: sent=${sent} failed=${failed}`);

    return new Response(JSON.stringify({ sent, failed }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Unhandled error in send-alt-alerts:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});