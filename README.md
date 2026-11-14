# homebridge-dyson-spot-scrub

A [Homebridge](https://homebridge.io) plugin for the **Dyson Spot+Scrub AI** robot vacuum and mop (product type 804, MQTT prefix `RB05`). The Dyson R2 Nurovi Wash+Dry (914, `RB07`) is handled by the same code but is untested.

> **Name check.** `homebridge-dyson-robot` on npm is a different, older plugin for the 360 Eye and Heurist. This plugin is published as `homebridge-dyson-spot-scrub`. If you installed the old one by mistake, run `npm uninstall -g homebridge-dyson-robot` first.

## How it works

The robot is controlled **only through Dyson's cloud**. It ignores ping and ports 1883 and 8883, so there is no local mode. The plugin signs in over HTTPS, fetches short-lived AWS IoT credentials, and holds one MQTT-over-WebSocket connection open on port 443. That means:

- Homebridge needs internet access. It does **not** need to be on the robot's Wi-Fi network, and no firewall ports need opening beyond HTTPS.
- If Dyson's cloud is down, only the robot's own button and schedule work.
- Every client signed in to your account sees every other client's messages, including the MyDyson app's.

## HomeKit services

| Service | What it does |
|---|---|
| **Clean** (switch) | On: cleans every room, each with the settings saved in the MyDyson app. Off: sends the robot home. On while paused: resumes. |
| **Battery** | Level, charging state, low-battery alert |
| **Docked** (contact sensor) | Closed = on the dock. Also reports Fault and Not Responding. |
| **Filter Maintenance** (one per consumable) | Life left and change indication |
| **Empty Bin**, **Wash Mop**, **Dry Mop** (switches) | Dock actions. Refused unless the robot is docked and the dock is idle. Can be hidden in the settings. |

There is no global clean mode: the robot cleans each room with that room's saved settings. Change them in the MyDyson app.

## Install

```
npm install -g homebridge-dyson-spot-scrub
```

Until it is published to npm, install straight from GitHub:

```
npm install -g github:UNsync3D/homebridge-dyson-spot-scrub
```

## Sign in (once)

Run the auth script from the plugin's folder.

Raspberry Pi or Linux service install:

```
sudo node /var/lib/homebridge/node_modules/homebridge-dyson-spot-scrub/scripts/auth.js
```

macOS or a user-level install:

```
node $(npm root -g)/homebridge-dyson-spot-scrub/scripts/auth.js
```

Use `--storage /path/to/homebridge` if your storage folder is somewhere else.

It asks for your Dyson email, country code (for example `AU`, `GB`, `US`) and password, then Dyson emails you a 6-digit code. **Your password and the code are not saved.** Only the token and country are written to `dyson-creds.json` in the Homebridge storage folder, readable by its owner only.

A wrong password, a wrong code and a locked account all return the same HTTP 401, and repeated failures lock the account for a while. If a step fails, wait a few minutes before retrying.

## Configure

```json
{
  "platforms": [
    {
      "platform": "DysonRobot",
      "name": "DysonRobot",
      "refreshIntervalSeconds": 30,
      "exposeDockActions": true,
      "logMqtt": false
    }
  ]
}
```

| Key | Default | Description |
|---|---|---|
| `refreshIntervalSeconds` | `30` | How often the plugin asks for a full state. The robot pushes changes but no regular snapshots. 10 to 300. |
| `exposeDockActions` | `true` | Show Empty Bin, Wash Mop and Dry Mop |
| `serials` | all | Only add these robots |
| `logMqtt` | `false` | Log every state message. Tokens, `localpwd`, emails and serials are redacted. |

Restart Homebridge after signing in.

## Upgrading from the old homebridge-dyson-robot plugin

The four mode switches (Vacuum, Vacuum and Mop, Mop, Vacuum then Mop) are gone, replaced by the Clean switch. Old services are removed from the cached accessory on first start. The platform name `DysonRobot` is unchanged, so your `config.json` keeps working. If tiles look stale, remove the cached accessory in the Homebridge UI and restart.

## Troubleshooting

**"Not signed in to Dyson"**: run the auth script and restart Homebridge.

**"Dyson rejected the saved sign-in"**: the token has expired or been revoked. Run the auth script again.

**Tiles show "No Response"**: the robot is offline in Dyson's cloud (check the MyDyson app), or Homebridge has no internet. Reads recover automatically when the robot reports it is back.

**Clean does nothing and snaps back off**: the robot refused. It must be on the dock and idle, with no real fault. A stale "tank missing" fault does not block a start, but the robot refuses the mop clean itself if the tank is still out.

## Not yet confirmed against real robot logs

These were written from the protocol notes and still need checking on a live robot. They are marked `ASSUMPTION` or `TODO` in the code:

- Home (`ABORT`): the protocol notes list no extra fields, but earlier notes said the app adds some
- The `get_preference` reply carries the rows under `room_preference`, and `set_preference` takes the same names back
- The manifest's field names, including the one holding the MQTT prefix (`mqttRootTopicLevel`)
- That consumable `usage` means percent worn
- Which `work_mode` value means "returning" (the protocol notes say 32, earlier notes said 38)
- How `STATE-CHANGE` names the new state, and whether R2 room rows have 11 or 12 values

## Development

```
npm install
npm test
```

The tests include a smoke test against the real HAP library. Layers: `src/dysonApi.js` (cloud REST), `src/dysonMqtt.js` (AWS IoT MQTT), `src/robotState.js` (pure state rules), `src/robotController.js` (commands), `src/accessory.js` (HomeKit services), `src/platform.js` (discovery).

Never log or post Dyson passwords, one-time codes, bearer tokens, emails, `localpwd` or serials.

## Licence

MIT
