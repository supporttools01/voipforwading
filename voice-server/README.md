# NX Voice SIP Gateway

This service layer receives inbound calls from SIP providers such as SharkPBX and enforces NX Voice routing rules before forwarding calls to agents.

## Architecture

Caller -> Provider TFN -> Provider SIP account -> NX Voice Asterisk -> campaign/CC routing -> agent destination

Supabase remains the control plane for customers, assigned numbers, campaigns, live calls, CDR and minute wallets. Asterisk is the media/signaling plane.

## Security

- Never commit SIP passwords or provider secrets.
- Keep provider credentials only on the VPS in `/etc/nxvoice/nxvoice.env` or equivalent secret storage.
- GitHub Pages must never receive SIP credentials.
- Rotate any credentials that were previously shared outside the server secret store.

## First provider test

Provider type: SharkPBX

- SIP domain: configured through `SHARKPBX_DOMAIN`
- SIP extensions: configured through `SHARKPBX_EXT_1` and `SHARKPBX_EXT_2`
- Public TFN/DID: configured as a non-secret routing value

## Deployment order

1. Provision Ubuntu VPS with a public static IP.
2. Install Docker and Docker Compose.
3. Copy `.env.example` to a server-only `.env` and insert the provider credentials.
4. Start the Asterisk container.
5. Confirm both SharkPBX registrations show `Registered`.
6. Call the TFN and confirm Asterisk receives the INVITE.
7. Enable NX Voice routing logic and Supabase event sync.
8. Test 2+ concurrent inbound calls.
9. Test agent forwarding, CDR and minute deduction.

The initial configs intentionally route inbound calls into a controlled `nx-inbound` context. Production outbound forwarding will be enabled only after an outbound carrier/trunk is confirmed.