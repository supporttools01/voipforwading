import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('SIGNALWIRE_WEBHOOK_SECRET') || '';
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function xmlEscape(value: string) {
  return value.replace(/[<>&'\"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '\"': '&quot;' }[c] || c));
}

function xml(body: string, status = 200) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function payload(req: Request) {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await req.json().catch(() => ({}));
  const fd = await req.formData().catch(() => null);
  if (!fd) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) out[k] = String(v);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  if (!WEBHOOK_SECRET) return new Response('Webhook secret not configured', { status: 503 });
  if (url.searchParams.get('token') !== WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  const data: any = req.method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : await payload(req);
  const event = url.searchParams.get('event') || 'inbound';

  try {
    if (event === 'answered') {
      const parentCallSid = url.searchParams.get('parent') || data.ParentCallSid || data.CallSid;
      if (!parentCallSid) return new Response('Missing CallSid', { status: 400 });

      const { error } = await supabase.rpc('update_signalwire_call_state', {
        p_provider_call_id: parentCallSid,
        p_status: 'answered',
        p_provider_payload: data,
      });
      if (error) throw error;
      return new Response('OK', { status: 200 });
    }

    if (event === 'dial-final') {
      const parentCallSid = url.searchParams.get('parent') || data.ParentCallSid || data.CallSid;
      const finalStatus = String(data.DialCallStatus || data.CallStatus || 'completed').toLowerCase();
      if (!parentCallSid) return xml('<Hangup/>');

      const { error } = await supabase.rpc('finalize_call_usage', {
        p_provider_call_id: parentCallSid,
        p_final_status: finalStatus,
        p_provider_payload: data,
      });
      if (error && !String(error.message || '').includes('Live call not found')) throw error;
      return xml('<Hangup/>');
    }

    const callSid = String(data.CallSid || data.call_sid || '');
    const to = String(data.To || data.to || '');
    const from = String(data.From || data.from || '');

    if (!callSid || !to) {
      return xml('<Say>Unable to route this call.</Say><Hangup/>');
    }

    const { data: rows, error } = await supabase.rpc('reserve_inbound_call', {
      p_provider_call_id: callSid,
      p_dialed_number: to,
      p_caller_number: from,
      p_provider_payload: data,
    });

    if (error) {
      console.log('route_rejected', error.message, { callSid, to, from });
      const reason = String(error.message || '');
      const message = reason.includes('No minutes')
        ? 'This account is temporarily unavailable.'
        : reason.includes('No destination')
          ? 'No forwarding destination is available.'
          : reason.includes('DID not assigned')
            ? 'This number is not configured for forwarding.'
            : reason.includes('No active campaign')
              ? 'No active forwarding campaign is configured.'
              : reason.includes('Campaign CC busy')
                ? 'All agents are busy. Please try again later.'
                : 'We are unable to route this call right now.';
      return xml(`<Say>${xmlEscape(message)}</Say><Hangup/>`);
    }

    const route = Array.isArray(rows) ? rows[0] : rows;
    if (!route?.destination_phone) {
      return xml('<Say>No forwarding destination is available.</Say><Hangup/>');
    }

    const answeredCallback = `${SUPABASE_URL}/functions/v1/signalwire-voice?event=answered&parent=${encodeURIComponent(callSid)}&token=${encodeURIComponent(WEBHOOK_SECRET)}`;
    const dialFinalCallback = `${SUPABASE_URL}/functions/v1/signalwire-voice?event=dial-final&parent=${encodeURIComponent(callSid)}&token=${encodeURIComponent(WEBHOOK_SECRET)}`;
    const destination = xmlEscape(String(route.destination_phone));
    // Use the purchased SignalWire DID as caller ID. This avoids carrier rejection
    // when the original caller's number is not an allowed/verified caller ID.
    const callerId = xmlEscape(to);

    console.log('route_reserved', {
      callSid,
      campaign: route.campaign_name,
      routingMode: route.routing_mode,
      destination: route.destination_label || destination,
    });

    // answerOnBridge keeps the original caller ringing until the forwarding
    // destination answers, then bridges both legs together.
    return xml(
      `<Dial timeout="45" answerOnBridge="true" callerId="${callerId}" action="${xmlEscape(dialFinalCallback)}" method="POST">` +
      `<Number statusCallback="${xmlEscape(answeredCallback)}" statusCallbackMethod="POST" statusCallbackEvent="answered">${destination}</Number>` +
      `</Dial>`,
    );
  } catch (error) {
    console.error('signalwire_voice_error', error);
    return xml('<Say>We are unable to complete your call right now.</Say><Hangup/>', 200);
  }
});
