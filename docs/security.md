# Security

Security provides a residential-style area panel alongside the Health monitor.
It uses your existing Zigbee2MQTT devices and broker connections. A live workspace
starts with no security areas, zones, schedules or alert actions configured.
The isolated simulation includes synthetic examples and cannot send real alerts.

## Set up an area

1. Open **Security**, then **Add area**. Give the area a name and choose its
   entry and exit delays. New areas are disarmed.
2. Open **Zones** and add the devices that protect that area. Search the device
   picker by name, network, model or Zigbee IEEE address. Select one or more
   **Areas** for the zone. Each zone names a device property and the value that
   means activation. For a typical
   Zigbee2MQTT contact sensor, `contact: false` means open; for a motion sensor,
   `occupancy: true` means motion. Check your device's actual reported values.
3. Choose **Entry** for an entry route that should start the area's entry delay,
   or **Instant** for immediate activation. Choose whether the zone is bypassed
   in Home mode, for example an indoor motion sensor.
4. Wait for fresh reports from the selected properties. The panel shows unknown,
   open/active and unavailable zones instead of claiming they are ready.
5. Add optional schedules and alert actions, then enable each one deliberately.

Device identities use the existing network and Zigbee IEEE identity. Renaming a
device preserves its zone link. A retired, disabled, missing or unavailable
device becomes a zone trouble condition; a replacement device must be selected
explicitly. Broker/device availability does not itself count as intrusion.

## Shared zones

A zone can belong to several areas. Edit its **Areas** checkboxes to choose the
memberships. Each selected area includes that same physical detector in its
readiness checks and evaluates a fresh activation whenever that area is armed.
For example, a contact assigned to House and Garage can raise two independent
incidents if both areas are armed. Disarming or acknowledging House does not
disarm or acknowledge Garage. Each area keeps its own entry/exit delays,
Home/Away mode, schedules, alarm memory and alert actions.

The zone's name, trigger condition, Entry/Instant type, reporting timeout,
enabled state and Home-mode exclusion are shared settings. A bypass also applies
to the zone in **every assigned area**; the panel warns about that scope before
applying it. Home exclusion follows each area's own mode, so a zone can be
excluded in a Home-armed area while still protecting an Away-armed area.

Disarm every linked area before changing or removing a shared zone. Adding it
to another area also requires that new area to be disarmed. Reset the zone's
alarm memory before changing its memberships. Removing an area detaches its
membership and retains the shared zone in its remaining areas. Removing the
last area removes that zone configuration, with audit history retained.

Existing single-area zones keep their original identity and settings when the
application is upgraded. Memberships are stored separately, so the upgrade does
not rewrite the existing zone records. An older open browser editing the
unchanged primary area also preserves the shared memberships; refresh to use
the multiple-area editor.

## Operate the panel

- **Arm Away** monitors all enabled, non-bypassed zones in the selected area.
- **Arm Home** also excludes zones configured to be bypassed in Home mode.
- Arming checks readiness. Unknown, unavailable or already-active participating
  zones block arming, and readiness is checked again when an exit delay ends.
  Existing alarm memory must be cleared before another arm cycle.
- An Entry zone starts the entry countdown. Disarming before it ends cancels
  that pending intrusion. Instant zones can raise an alarm immediately.
- **Disarm** stops further intrusion evaluation for the area. It retains alarm
  memory and its audit trail. An alert already queued for a raised intrusion
  still gets its attempt; disarming during an entry delay creates no intrusion.
- **Acknowledge** records that an operator has seen the alarm. **Reset** clears
  working alarm memory after the area is disarmed. These are separate actions.
- A zone can be bypassed for a chosen time or indefinitely, with a reason. Its
  real status and the bypass remain visible. Ending a bypass does not manufacture
  a new sensor activation.

Area configuration is changed while the area is disarmed. Removing an area also
requires all areas sharing its zones to be disarmed. The Security panel uses
the signed-in account. The separate Keypad page uses the PIN flow described below.

## Schedules

Add separate weekly entries for arming and disarming. Each entry specifies an
area, weekdays, local time, timezone and desired mode. Schedules start disabled.
They use the same readiness checks as manual arming and record blocked attempts.
They do not automatically bypass open or unavailable zones.

Timezone rules account for daylight saving. A repeated local minute runs once;
a nonexistent local time is skipped. Schedules do not catch up missed actions
after downtime or a clock jump. Review the event history when a scheduled arm
did not complete. Display times follow the application timezone.

## MQTT, email and browser push alert actions

Actions belong to an area and start disabled. When a fresh activation raises an
intrusion, each enabled action receives one queued attempt for that incident.
Repeated active reports do not produce a stream of alerts. Alarm acknowledgement,
disarm and reset retain their separate meanings.

For **MQTT**, select an existing broker and a concrete event topic, for example
`security/alerts`. The payload is a JSON object with optional placeholders:

```json
{
  "event": "{{event}}",
  "area": "{{area}}",
  "zone": "{{zone}}",
  "device": "{{device}}",
  "timestamp": "{{timestamp}}",
  "incidentId": "{{incidentId}}"
}
```

`{{mode}}` is also available. Values are substituted as data; templates cannot
run JavaScript. Topics cannot contain wildcards, reserved system prefixes,
device `/set` or `/get` commands, or bridge request paths. Messages use QoS 1
and are not retained. Broker acceptance does not prove that a downstream consumer
acted on a message. Consumers can use `incidentId` to identify an incident.

For **Email**, use the existing SMTP configuration and recipient. Set a security
subject and message using the same placeholders. An accepted result means SMTP
acceptance, rather than confirmed inbox delivery. Existing health email remains
separate from Security actions.

### Browser push

1. On the phone, open the HTTPS app and **My account & app**. Enable notifications
   for that browser. The signed-in account must be enabled and have **View
   security areas & alarms**; Health monitor access alone cannot receive Security
   alarms.
2. Under **Security → Alert actions**, add an action for the area, choose
   **Browser push**, and select one or more eligible registered browsers. New
   actions start disabled; enable the action when ready. Existing registrations
   and the VAPID key are reused.
3. Use **Security preview** beside your own browser registration to check the
   phone. This sends a clearly labelled test and creates no intrusion, arming
   change, MQTT message or email.

Each selected browser receives one attempt for the raised incident and action.
Recipients are pinned when the incident is queued; registering a new phone does
not retarget an old alert. Permission removal, account or browser disablement,
removing the browser and switching global push off suppress unsent deliveries.
Restoring access does not replay those alerts. Every recipient is checked again
immediately before its attempt. One successful phone does not cause a failed
phone to be retried.

The shared global push switch and lock-screen privacy setting apply. By default
the notification says a Security alarm was detected; area and zone details are
included only when **Include device and alarm details on the lock screen** is
enabled. Security
uses a high-urgency push request, but the phone's notification permissions and
system settings still control presentation. Tapping opens Security and selects
the incident's area when it is still available. It never acknowledges, disarms
or resets anything. Refresh the installed app after an update so it has the
current notification handler.

The Security delivery log records per-browser accepted, suppressed, expired or
uncertain results. The parent action is accepted when at least one eligible
browser is accepted and no attempt is uncertain or expired; its per-browser rows
show suppressed recipients separately. Accepted means the push service accepted
the message; check the handset to establish receipt. Acknowledgement or disarming after an intrusion
does not cancel its already queued alert. Resetting the incident suppresses
deliveries still queued; an attempt already in progress may finish. Security
does not send arm/disarm or recovery notifications in this release.

The publisher is separate from the subscription-only health collector. An attempt
is recorded before sending. Ambiguous or interrupted attempts are marked
uncertain and are never automatically retried. Queued pre-restart outputs are
suppressed, rather than replayed when the service returns. Disabling or removing
an action, or explicitly resetting its incident, suppresses messages still queued
for a future attempt. An attempt already in progress may finish.
Queued attempts expire after five minutes rather than sending a stale alert.
No alerts are sent merely by opening the panel or configuring an area.

## Restart behaviour

Fully armed Home/Away areas and latched alarm memory persist across a restart.
The panel requires fresh zone reports again and shows trouble while waiting.
Retained or duplicate MQTT messages cannot establish a fresh activation. A fresh
activation in an already-armed area can raise an intrusion after reconnection;
repeated active reports do not create another incident in that arm cycle.

An unfinished exit delay is cancelled and the area returns to Disarmed with an
audit event. A restart during an entry delay retains the area as armed and
latches the pending activation in alarm memory without replaying outputs. An
operator should review that memory before resetting the area.

## Tablet and phone keypad

Open **Keypad** for a touch panel. On a landscape tablet the area list occupies
one third of the panel and the keypad occupies the remainder. On a phone the
area list appears above the keypad. The clock uses the dashboard timezone.

Each area has three independent indicators. The green Ready LED is steady
when its enabled zones are normal. The same green LED flashes when any enabled
zone is open, active, unknown or in trouble, and while the area has alarm memory.
The yellow Trouble LED stays on for zone trouble, and the red Armed LED stays
on while the area is armed or arming. They can be lit together. Disabled areas
or areas without enabled zones show an unavailable state instead of Ready.

Select areas with their checkboxes. Browse zone issues with the left/right
buttons or open **Show all not ready zones** for the complete list. The display
includes bypassed and Home-excluded zones; their labels explain why arming can
still be permitted. Arming continues to use the existing protection rules.
Named states remain visible with reduced motion enabled.

**Arm away** needs Security control permission in the signed-in account and
does not need a PIN. Existing readiness checks apply. The keypad shows blocking
zones and never silently bypasses them. A multi-area command either succeeds
for the complete selection or leaves it unchanged.

Set a personal four-digit PIN in **My account & app → Keypad PIN**, confirming
your current dashboard password. An administrator can also use **Users →
Keypad access** to assign permitted areas, replace a PIN or remove it.
Administrators have all areas, including future areas; other users start with
no assigned areas. A PIN is usable only while its owner is enabled and has
Security control permission. Each saved PIN must be unique.

The keypad requires a PIN for **Disarm selected** and **Disarm all assigned**.
Disarming is attributed to the PIN owner. A signed-in Security viewer
can display a wall keypad; the entered PIN supplies the authority to disarm.
An explicit selection containing an unassigned area is rejected as a whole.
The all-areas command means all areas permitted to that PIN owner.

PINs are stored with salted password hashing and an installation-key-bound
lookup. The API never returns a saved code. Failed PIN and current-password
attempts are rate-limited in persistent storage. Entered keypad digits are
cleared after a command, selection changes, inactivity or hiding the page.
No PIN is created automatically during an upgrade.

Existing Security panel controls retain their feature permissions. Weekly
schedules continue to use their configured actions and do not prompt for a PIN.

## Permissions, storage and backup

**View security areas & alarms**, **Arm / disarm & bypass zones** and
**Security setup & alert actions** are separate per-user feature checkboxes.
The latter two imply panel visibility but do not imply each other. Setup includes
authoring and enabling schedules, so it permits automated arm/disarm decisions;
grant it only to trusted security-automation authors. The control checkbox governs
manual operation. A security-only user does not inherit broker credentials,
SMTP administration or unrelated health history. Administrator access remains
fixed to every feature; existing Operator/Viewer presets remain unchanged.

Security configuration, incidents, activity and delivery results are stored in
the same SQLite database and included in the existing database/key backup.
History follows **Thresholds & retention**, defaulting to 90 days. Working alarm
memory, area/zone configuration and active bypasses survive history pruning.
