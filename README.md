# Discord Cross-Server Search

A console script that adds a search overlay to the Discord desktop client, letting you search a query across every server you're in at once and optionally export the combined results to CSV.

Discord's built-in search only works on one server at a time. This script loops through every server you select, pulls every page of results for your query per server, merges them into a single chronological list, and gives you clickable links that jump straight to each message in the Discord client.

## **DISCLAIMER:**
**Pasting a script into a javascript console is INHERENTLY RISKY. I wrote this script as a helpful tool but you should always verify the content of scripts just in case.**

## Table of Contents
- [Risks](#please-read-about-the-risks-first)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## PLEASE Read about the risks first:

### Risk 1: Pasting code into a developer console is like, SO dangerous

Anything pasted into Discord's developer console runs with **full access to your account**, including your auth token. A malicious script can steal your token, read all your messages, send messages as you, change your credentials, or persist itself across restarts. This is how most common discord "playtest my game" scams work, and why I repeatedly state that you should read and understand the code before pasting it.

Discord shows a red "Pasting anything in here could give attackers access to your Discord account." warning when you open the console for this exact reason. **Never paste code you don't fully understand or can't verify yourself.**

### Risk 2: This uses Discord's API in a way Discord doesn't officially allow

Discord's ToS prohibits "self-bots" (automation using your user token, which happens to be exactly what this is). This script qualifies because it makes search API calls in a loop on your behalf. I have added intentional speed limiting to mitigate this risk, but you should still proceed with caution.

**The practical risk is low but never zero.** Discord's anti-abuse systems mostly target spamming and scraping, not searching. But Discord can warn, suspend, or ban any account for self-bot activity at any time.

### Safety recommendations:
- Use a secondary account if you have anything to lose (Such as: nitro, server ownership, important DMs, boost streaks, or profile badges).
- Don't overuse it.
- Don't share your token or post unredacted console output to this repo. **Make sure when submitting an issue you redact any account info!**
- Stop using the script if Discord sends unusual security prompts.

### "Buga, I don't trust you or your sketchy script"

You can (and should) read every line before running it. It only:

1. Reads your token from your Discord session to be able to send valid seach requests via the search API.
2. Reads your server list to allow for precise search range toggles
3. Builds a draggable window that overlays the main discord interface.
4. Makes requests to `discord.com/api/v9/guilds/{id}/messages/search` (the same endpoint that Discord's native search bar uses).
5. Displays merged results and lets you export to CSV. This is the only part of the script that does anything related to your files.

It does **not** send data to any third party or modify Discord's files.

**Don't take my word for it.** Open the script in a text editor and confirm the only network requests go to `discord.com`. If you can't verify that yourself, find someone who can. Even ask an LLM if you must. You should never run code you don't understand!

If you have any questions, my socials are all on https://buga.lol/ or look up my username (it's the same on every platform.)

---

## Features

- Cross-server search with individual server selection checkboxes
- Chronological merging of all results across all selected servers
- Click any result to jump to that message in Discord, just like the native search
- CSV export with timestamps, server names, authors, content, and message links
- Live progress bar and search status updates
- Automatic error 429 (rate limit exceeded) reaction. This script will pause for 20 seconds before continuing
- Collapsible and draggable overlay

---

## Installation

### 1. Enable the developer console (one-time setup)

1. Open Discord desktop on Windows.
2. Go to **Settings** (gear icon) > **Advanced** > enable **Developer Mode**.
3. Close settings, then press **Ctrl + Shift + I** to open the dev console.

### 2. Allow pasting

Click inside the console, type `allow pasting`, and press Enter. (This is usually a bad idea but unfortunately necessary to use external tools on vanilla discord.)

### 3. READ WHAT YOU ARE PASTING!!! If you don't understand Javascript, do not do this, or find someone who does.

### 4. Paste and press enter

The overlay should appear. The console will log something like:

```
[xsearch] Ready: 27 guilds, nav=true
```

You can now close the console/developer tools tab and use the overlay.

---

## Usage

It really should be pretty self-explanatory as all the buttons are labeled clearly. If you don't understand something, open an issue so I can clarify it for others.

### Search timing

The script uses intentionally slow delays to avoid spamming Discord's servers:
- 2 seconds between search pages within a server
- 4 seconds between searching servers

A typical search across 20 servers takes 3-8 minutes depending on result counts. Stopping the search prematurely will only display results collected thusfar.

If Discord returns a 429 error (basically happens when there's too many requests in a short time), the script pauses for 20 seconds and retries automatically.

### CSV columns

`timestamp`, `server`, `channel_id`, `author`, `content`, `link`

The file also includes a UTF-8 BOM to handle emoji and non-Latin characters correctly if opened with Excel.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Could not retrieve token" or "Found 0 guilds" | Discord's internal code structure may have changed since the last update. Open an issue with the console error and your Discord version. |
| Nothing happens when pasting | Type `allow pasting` in the console first. |
| Search returns nothing | Check that servers are selected and the query isn't empty. Open the console for red errors and create an issue report if any are present. |
| Clicking results doesn't navigate | Check for `nav=false` in the console log at startup. Navigation may be unavailable on your build. |
| Discord crashes or freezes | Quit Discord fully (tray icon > Quit) and reopen. The script does not remain in between launches. |

---

## FAQ

**Will I get banned?** Probably not, but the chance is never 0. See Risk 2 above. I recommend using a secondary account or alt to be safe.

**Browser version?** I designed this for and and tested on the Windows desktop client only. May work on other platforms, I haven't tested it.

**Mac/Linux?** No idea. Use Cmd+Option+I to open console on Mac and get in touch if it does work so I can update this accordingly.

**DMs?** Not supported. If you want to search all dms at once, this can be done natively on the mobile app as of time of writing

**Do I re-paste every restart?** Yes. Persistence may be possible with a modded client like BetterDiscord or Vencord, but I wanted something self-contained

**Can I modify it?** Yes. Use and js editor environment or even notepad. I actually wrote this in notepad++.

---

## License

Do literally whatever you want with this. I wanted this tool to exist and couldn't find it, so I made it myself. I am in no way responsible if it breaks your Discord, your account, or your computer. I mean, it shouldn't, but you never know.
