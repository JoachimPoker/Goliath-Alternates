// supabase/functions/send-alt-alerts/index.ts
//
// Triggered by a Supabase Database Webhook on UPDATE of the tournaments
// table (see setup instructions). Checks whether the alt-number change
// just crossed anyone's alert threshold, and if so, sends them a real
// push notification - this works even with their browser fully closed,
// since delivery goes through the browser vendor's own push service
// (Apple/Google), not a live connection to this site.
//
// Deploy with:
//   supabase functions deploy send-alt-alerts
//
// Needs these secrets set first (see setup instructions):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_CONTACT_EMAIL=...

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Alert threshold: fires once the calling number reaches or passes
// someone's own number - no early warning buffer. Set this above 0 if
// you ever want a "getting close" heads-up instead (e.g. 5 means
// alerted once calling is within 5 of their number).
const ALERT_BUFFER = 0;

Deno.serve(async (req) => {
  try {
    const payload = await req.json();

    // Only care about actual UPDATEs where current_alt_number changed.
    if (payload.type !== "UPDATE") {
      return new Response("ignored (not an update)", { status: 200 });
    }

    const record = payload.record;
    const oldRecord = payload.old_record;
    if (!record || record.current_alt_number === oldRecord?.current_alt_number) {
      return new Response("ignored (alt number unchanged)", { status: 200 });
    }

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
      return new Response("ignored (alerts disabled)", { status: 200 });
    }

    const currentNum = record.current_alt_number;

    const { data: subs, error } = await supabaseAdmin
      .from("push_subscriptions")
      .select("*")
      .eq("tournament_id", record.id)
      .eq("notified", false)
      .lte("target_alt_number", currentNum + ALERT_BUFFER);

    if (error) throw error;
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
        // Each person's message is personalized to their own number.
        const personalized = JSON.stringify({
          title: `${record.name}`,
          body: `It's your number! Now calling #${currentNum} - your number (#${sub.target_alt_number}) is up. Head to the desk!`,
          tag: `alt-${record.id}`
        });
        return webpush.sendNotification(pushSubscription, personalized);
      })
    );

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

    return new Response(JSON.stringify({ sent, failed }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});