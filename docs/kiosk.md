# Local kiosk

The dedicated `/kiosk` page provides a residential keypad without a dashboard
login. It shows the areas permitted by the administrator, their indicators and
zone issues, the date/time, and a numeric keypad. It has no dashboard navigation,
user administration, reports, broker settings or notification configuration.

**Arm away** does not require a PIN. Existing zone readiness checks still apply.
Disarming requires a personal four-digit PIN belonging to an enabled user with
Security control permission. The requested areas must be permitted to both
the kiosk and that PIN owner. **Disarm all permitted** covers the intersection
of those two sets; it does not control hidden or unassigned areas. PIN failures
use the same persistent retry limit as the signed-in keypad.

## Setup

1. Sign into the normal dashboard as an administrator.
2. Open **Configuration → Local kiosk**.
3. Enter the direct local address of this installation, including its port.
   Use a literal private IPv4 address, or loopback for a local-only installation.
   The address must already be recognised by the application's host settings.
4. Add the trusted local networks in CIDR form and choose all areas or a specific
   set of areas to display and control.
5. Enable the kiosk and confirm the access change. The kiosk is disabled by
   default; an upgrade does not enable it or create a dashboard account.
6. Open the displayed address ending in `/kiosk` on the tablet. No dashboard
   password or browser login session is needed there.

PINs are set through **My account & app → Keypad PIN**, or **Users → Keypad
access** for an administrator. A kiosk does not store the entered PIN or exchange
it for a dashboard session. Area access, account status and PIN validity are
checked for each disarm command. Disabling the kiosk takes effect on subsequent
requests, including tablets that already have the page open.

## Local access boundary

The kiosk accepts requests only for its configured local IP origin and from
its trusted networks, using the actual connection address. It rejects forwarded
or proxied requests, public hostnames and Cloudflare traffic. A tunnel's private
source address does not grant kiosk access. Forwarded headers are never used
to identify a permitted kiosk client. Command requests must come from the same
origin and use JSON.

Everyone who can access the enabled kiosk from those networks can see the
selected area and zone status and arm those areas. The PIN remains required
to disarm. Choose the kiosk networks and displayed areas accordingly. Remote
access continues through the normal authenticated dashboard; `/kiosk` is not
available through that remote route.

Kiosk access is stored with the existing configuration and included in the
database/key backup. It creates no extra user account, session or PIN. The
existing Security panel, schedules and alert delivery keep their own permissions
and behaviour. A disconnected or disabled kiosk cannot issue commands using
stale status displayed on its screen.
