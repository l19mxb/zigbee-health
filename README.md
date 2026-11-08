# Zigbee Health

A self-hosted, alarm-first dashboard for devices across multiple Zigbee2MQTT
networks. Try the isolated simulation without connecting to a broker.

![Dashboard with synthetic demonstration devices](docs/dashboard.png)

## Features

- Priority alarm stack, acknowledgement notes and restored-alarm processing.
- Searchable, sortable, paginated issue and healthy-device tables.
- Multiple brokers/base topics, with broker and bridge outage detection.
- Offline, stale, low battery, weak LQI, missing inventory and repeated dropout
  conditions. Global thresholds, device overrides, persistence and hysteresis.
- Timed or indefinite device/category/network shunts. Actual health and history
  remain visible. Expiry rearms a continuing fault once.
- Device reports, battery/LQI charts, event timelines and CSV export.
- Retirement/restoration, confirmed history deletion and links for moved or
  replacement devices.
- SMTP fault/recovery notifications with duplicate suppression and delivery history.
- Installable PWA with browser push, individual browser removal and delivery history.
- Optional MQTT broker connection monitoring and a bounded live topic log.
- Editable **90-day default retention**. Working alarms, active shunts and current
  configuration survive history cleanup.

Built with React, Vite, Node.js 24, SQLite, MQTT.js and Nodemailer. This early
release uses one shared operator identity: **Local operator**.

## Local use

Install Node.js 24 and pnpm 11.25.0, then:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

Open <http://127.0.0.1:18920>. Simulation contains 64 synthetic devices, keeps
data in `data/simulation`, and cannot enable real broker or email connections.
To reset it, stop the app and remove only that simulation directory.

`pnpm start` opens a separate live workspace in `data/live` with no brokers and
email disabled. Add each network in Configuration, then enable its connection.
New broker entries start disabled. Simulation databases cannot open as live data.
Existing installations keep their database, credential key, brokers and SMTP
settings when upgrading. Back up the data directory first; do not start a blank
volume over an existing installation.

For development, start the backend and run `pnpm dev` in another terminal. Vite
uses port 18921 and proxies the API to port 18920.

## Docker Compose

```sh
cp .env.example .env
# Set a unique ZIGBEE_HEALTH_PASSWORD of at least 12 characters in .env.
docker compose up --build -d
```

Default binding is loopback on port 18920. For trusted LAN access, set
`BIND_ADDRESS` to the host LAN address and `PUBLIC_HOST` to the hostname or IP
used in the browser. Review port and container/volume names before deployment.
Compose uses an unprivileged process, read-only root filesystem, private data
volume and no Docker socket. Use an authenticated HTTPS reverse proxy for remote
access; do not expose the unencrypted administrative interface to the internet.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Native bind address; Compose uses `0.0.0.0` internally |
| `PORT` | `18920` | Native port; Compose uses `8080` internally |
| `DATA_DIR` | `data/live` or `data/simulation` | Database/key directory |
| `PUBLIC_HOST` | empty | Additional permitted browser hostname(s), comma separated |
| `APP_PASSWORD` | empty | Native login password; required outside loopback |
| `TZ` | `UTC` | IANA timezone for displayed timestamps, including DST |
| `BIND_ADDRESS` | `127.0.0.1` | Compose host bind address |
| `APP_PORT` | `18920` | Compose published port |
| `ZIGBEE_HEALTH_PASSWORD` | required | Compose login password |

The shared password provides no per-person audit attribution. The actor is
always Local operator.

The login screen offers **Stay signed in for 30 days**, off by default. Without
it, a session lasts up to 12 hours and ends on an app restart. With it, a session
survives restarts for an absolute 30-day period; activity does not extend expiry.
Sign out revokes the current session immediately. Changing `APP_PASSWORD` and
restarting invalidates remembered sessions. Only hashes of random session tokens
are stored in SQLite; the password and raw tokens are never saved there. Cookies
are HttpOnly and SameSite=Strict, with Secure on the configured HTTPS origin.
Cloudflare Access has its own session duration and may require a separate login.
Backups contain session hashes and expiry records, so treat them as private.

## Device identity and lifecycle

Records use their network ID and Zigbee IEEE address. A friendly-name change on
the same network preserves history, settings and alarms. Matching names across
networks remain distinct.

- **Retire** stops collection and monitoring, closes working alarms with a retired
  outcome, suppresses queued notifications and cancels device shunts. History
  remains within retention. Rediscovery does not reactivate the device. This
  does not unpair it from Zigbee2MQTT.
- **Restore** resumes monitoring with a fresh baseline. Old battery, signal and
  availability values do not imply health; a new live report is required.
- **Link previous** connects a retired record to its successor. Moved devices
  must share the same IEEE address; replacement hardware has a different address.
  Reports navigate between records while keeping measurements and alarms
  separate. Links can be removed with an audit reason.
- **Delete history** requires retirement, the current device name, the literal
  `DELETE HISTORY` and a reason. This removes the record's samples, incidents,
  delivery records, device shunts and past events from the current database.
  The retired identity, settings, links and a new deletion audit entry remain
  to prevent automatic rediscovery. Existing backups are unchanged.

Inventory disappearance raises a missing-device condition rather than silently
deleting a record. Retired identities and structural links survive pruning.

## Monitoring and email

The collector subscribes to existing Zigbee2MQTT inventory, state, availability
and events. It publishes no queries, controls, scans or MQTT will. Read-only broker
ACLs are recommended; publish permission is unnecessary. Each broker/base-topic
entry represents one network.

Retained sensor messages do not establish a live baseline. Non-retained receipt
time is not proof of a newly sampled physical measurement. Source outages suspend
device classification instead of declaring every device offline. Signal is
**LQI**, never invented dBm. Tune timeouts for sleepy devices; availability depends
on your existing bridge configuration.

Configure SMTP in Email. Use TLS/STARTTLS for authenticated SMTP. Acknowledgements
and shunts suppress pending fault messages. An accepted alarm can have one
recovery message. “Accepted” means SMTP acceptance, not inbox delivery. Ambiguous
attempts remain uncertain and are never automatically retried.

### Other MQTT brokers and live logs

Choose **MQTT broker & topic log** for a broker without Zigbee2MQTT. This monitors
the MQTT connection and rejected subscriptions; it does not infer individual
service/device health from arbitrary messages. Leave topic filters empty for
connection-only monitoring, or add up to 20 filters, one per line. For example,
`service/available` or `board/+/state`. Zigbee2MQTT remains the default mode.

**Live log** shows the latest 200 received messages per entry, newest first, with
retained flags, filtering and pause. Logs are held only in memory and clear on
restart, disabling or reconfiguration. Previews are limited to 1,000 characters;
large/binary payloads are omitted and common secret fields are redacted. Redaction
cannot recognise every secret: limit topic scope and review before sharing.
No broad wildcard is selected by default for generic brokers.

MQTT connected and Zigbee inventory/bridge state are displayed separately. A
connected broker with no inventory might use a different base topic or have no
Zigbee2MQTT bridge. A network with device history cannot change mode; add another
entry to preserve its history.

## Installable app and browser notifications

Android Chrome is the primary target. Web Push requires a secure HTTPS origin,
a service worker and an explicit permission grant. The LAN HTTP address remains
usable as a dashboard but cannot enrol normal browser push subscriptions.

1. Route an HTTPS hostname through your reverse proxy or Cloudflare Tunnel to
   the existing dashboard HTTP origin. Preserve the public `Host` header. Keep
   the app password and any existing access protection enabled.
2. In **Configuration → App & notifications**, save that root HTTPS address
   (for example `https://health.example.test`) and enable push delivery. This
   also permits the hostname at the app. Public-host sessions use Secure cookies.
3. Open that HTTPS address in Android Chrome, sign in, choose **Enable on this
   device**, and allow notifications. Give each browser a recognisable label.
4. Use **Send test** and verify the notification on the named phone. Install via
   Chrome's menu → Add to Home screen → Install, or the in-app Install button
   when Chrome offers it.

The push service receives an encrypted payload; the service worker displays it
without fetching an authenticated API in the background. Tapping it opens the
alarm viewer, where an expired app/proxy login may require signing in again.
It never acknowledges or shunts an alarm. Proxy access rules must allow the
authenticated browser to register the service worker and load its assets; verify
your actual proxy/phone combination after setup.

Device names/descriptions are omitted by default for lock-screen privacy. New
subscriptions receive future alarms without replaying the current stack. Fault
and optional recovery notifications follow acknowledgement/shunt rules. The
push service's acceptance does not prove handset delivery. Messages expire after
five minutes; ambiguous outcomes are recorded without automatic retries. Expired
subscriptions are disabled, and can be enabled again from the browser.

Changing the HTTPS app address disables existing subscriptions. Signing out does
not disable push: remove the browser in notification settings to stop it. Android
permissions, battery restrictions and connectivity affect delivery. Keep SMTP as
a separate fallback where desired. Simulation cannot enrol or send real push.

VAPID signing keys and browser subscription secrets are encrypted using the same
data-directory key as other credentials. Preserve that directory during updates
and backups. No third-party push account or API key is required; the server needs
outbound HTTPS access to the browser's push provider. Supported endpoints include
Chrome/FCM, Firefox, Apple Web Push and Windows push services.

Offline mode displays an explicit connection-unavailable page. Only generic
offline assets are cached; API responses, alarm states and authenticated pages
are never cached by the service worker.

## Storage and backup

SQLite keeps five-minute measurement summaries and individual incident/event
transitions. Cleanup runs hourly. Eligible old history expires under the retention
threshold; working alarms, active shunts and configuration remain independent.
Backup retention is separate.

Passwords are encrypted with a separate `secrets.key`. Protect the whole data
directory: the database and key together permit decryption. Never commit data,
`.env`, backups or real diagnostics.

Create an explicit online backup to a new directory:

```sh
node server/backup.mjs data/live/health.db /private/backups/new-backup
```

It includes the database, matching key and integrity/hash manifest. No schedule
is installed. Restore both `health.db` and `secrets.key` while the app is stopped
and point `DATA_DIR` at that private directory. Keep live/simulation backups separate.

## Development

```sh
pnpm test
pnpm build
```

Tests use synthetic records, loopback brokers and a local SMTP sink. CI also
builds and smoke-tests the container. Real broker and email compatibility depend
on deployment configuration; no production data is included here.

See [CONTRIBUTING.md](CONTRIBUTING.md). Redact addresses, names, credentials and
personal information before sharing issues, logs or screenshots.

## License

[MIT](LICENSE), copyright Zigbee Health contributors. Dependencies retain their
own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). No code from
other Zigbee dashboards is included.
