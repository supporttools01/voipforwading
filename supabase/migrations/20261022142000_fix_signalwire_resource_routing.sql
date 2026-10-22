create or replace function public.reserve_inbound_call(p_provider_call_id text, p_dialed_number text, p_caller_number text, p_provider_payload jsonb default '{}'::jsonb)
returns table(live_call_id uuid, user_id uuid, campaign_id uuid, number_id uuid, destination_id uuid, destination_phone text, destination_label text, campaign_name text, routing_mode text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_number public.assigned_numbers%rowtype;
  v_profile public.profiles%rowtype;
  v_wallet public.minute_wallets%rowtype;
  v_campaign public.campaigns%rowtype;
  v_destination public.forwarding_destinations%rowtype;
  v_existing public.live_calls%rowtype;
  v_live_id uuid;
  v_normalized text := regexp_replace(coalesce(p_dialed_number,''),'[^0-9]','','g');
  v_effective_dialed_number text := p_dialed_number;
begin
  if coalesce(trim(p_provider_call_id),'')='' then raise exception 'Provider CallSid required'; end if;

  select * into v_existing from public.live_calls where provider_call_id=p_provider_call_id;
  if v_existing.id is not null then
    return query
    select v_existing.id,v_existing.user_id,v_existing.campaign_id,v_existing.number_id,v_existing.destination_id,d.phone_number,d.label,c.name,c.routing_mode
    from public.forwarding_destinations d join public.campaigns c on c.id=v_existing.campaign_id
    where d.id=v_existing.destination_id;
    return;
  end if;
  if exists(select 1 from public.cdr where provider_call_id=p_provider_call_id) then raise exception 'Call already finalized'; end if;

  -- SignalWire Click-to-Call sends the public resource URI as To.
  -- Resolve that test resource to an active SignalWire-assigned TFN.
  if lower(trim(coalesce(p_dialed_number,''))) = 'resource:/public/nx-voice-live-router' then
    select n.* into v_number
    from public.assigned_numbers n
    join public.campaign_numbers cn on cn.number_id=n.id
    join public.campaigns c on c.id=cn.campaign_id
    where n.enabled=true
      and n.user_id is not null
      and lower(coalesce(n.provider,''))='signalwire'
      and c.enabled=true
      and (c.call_cap is null or c.completed_calls<c.call_cap)
    order by c.updated_at desc, c.created_at asc
    limit 1;
    if v_number.id is null then raise exception 'No active SignalWire number configured for Click-to-Call'; end if;
    v_effective_dialed_number := v_number.phone_number;
  else
    select * into v_number from public.assigned_numbers n
    where n.enabled=true and n.user_id is not null and regexp_replace(n.phone_number,'[^0-9]','','g')=v_normalized limit 1;
  end if;

  if v_number.id is null then raise exception 'DID not assigned'; end if;
  select * into v_profile from public.profiles p where p.id=v_number.user_id and p.role='customer' and p.status='active';
  if v_profile.id is null then raise exception 'Customer unavailable'; end if;

  if v_profile.max_concurrent_calls < 1 or
     (select count(*) from public.live_calls l where l.user_id=v_profile.id and l.status in ('ringing','answered')) >= v_profile.max_concurrent_calls then
    raise exception 'Account CC busy';
  end if;

  select * into v_wallet from public.minute_wallets w where w.user_id=v_profile.id for update;
  if v_wallet.user_id is null or v_wallet.remaining_seconds<=0 then raise exception 'No minutes remaining'; end if;

  select c.* into v_campaign from public.campaigns c join public.campaign_numbers cn on cn.campaign_id=c.id
  where cn.number_id=v_number.id and c.user_id=v_profile.id and c.enabled=true and (c.call_cap is null or c.completed_calls<c.call_cap)
  order by c.updated_at desc,c.created_at asc limit 1 for update of c;
  if v_campaign.id is null then raise exception 'No active campaign'; end if;
  if v_campaign.routing_mode='simultaneous' then raise exception 'Simultaneous routing not enabled'; end if;
  if (select count(*) from public.live_calls l where l.campaign_id=v_campaign.id and l.status in ('ringing','answered'))>=v_campaign.max_concurrent_calls then raise exception 'Campaign CC busy'; end if;

  select d.* into v_destination from public.forwarding_destinations d
  where d.campaign_id=v_campaign.id and d.enabled=true and (d.call_cap is null or d.completed_calls<d.call_cap)
    and (select count(*) from public.live_calls l where l.destination_id=d.id and l.status in ('ringing','answered'))<d.max_concurrent_calls
  order by case when v_campaign.routing_mode='round_robin' then d.completed_calls else 0 end asc,d.priority asc,d.created_at asc
  limit 1 for update skip locked;
  if v_destination.id is null then raise exception 'No destination available'; end if;

  insert into public.live_calls(provider_call_id,user_id,campaign_id,number_id,destination_id,caller_number,dialed_number,forwarded_to,status,provider_payload)
  values(p_provider_call_id,v_profile.id,v_campaign.id,v_number.id,v_destination.id,p_caller_number,v_effective_dialed_number,v_destination.phone_number,'ringing',coalesce(p_provider_payload,'{}'::jsonb))
  returning id into v_live_id;
  return query select v_live_id,v_profile.id,v_campaign.id,v_number.id,v_destination.id,v_destination.phone_number,v_destination.label,v_campaign.name,v_campaign.routing_mode;
end; $function$;
