# Discord Cross-Server Search

A console script that adds a search overlay to the Discord desktop client, letting you search a query across every server you're in at once and export the combined results to CSV.

Discord's built-in search only works on one server at a time. This script loops through every server you select, pulls every page of results for your query, merges them into a single chronological list, and gives you clickable links that jump straight to each message in the Discord client.

# **DISCLAIMER:**
**This readme was written by an LLM based on my specific instructions because I was too lazy to do it. Pasting a script into a javascript console is INHERENTLY RISKY. I wrote this script as a helpful tool but you should always verify the content of scripts just in case.**

---

## Table of contents

1. [Read this first: the risks](#read-this-first-the-risks)
2. [What this specific script does](#what-this-specific-script-does)
3. [Installation](#installation)
4. [Using the overlay](#using-the-overlay)
5. [What to expect during a search](#what-to-expect-during-a-search)
6. [Exporting results](#exporting-results)
7. [Troubleshooting](#troubleshooting)
8. [FAQ](#faq)

---

## Read this first: the risks

There are **two separate risks** here. Please read both sections before running anything.

### Risk 1: Pasting code into a developer console is dangerous

The Discord developer console is the same kind of console used by browsers. Anything you paste into it runs with **full access to your Discord account**, including your authentication token. A malicious script pasted into this console can:

- Steal your account token and send it to an attacker
- Read every message in every server and DM you have access to
- Send messages, join servers, leave servers, or delete content as you
- Change your password, email, or 2FA settings if your session is unlocked
- Persist itself so it runs every time you open Discord

This is why Discord shows a giant red **"Self-XSS" warning** when you open the console. That warning exists because real people have been tricked into pasting malicious code that drained their accounts, stole their Nitro, or used them to scam their friends.

**The rule is simple: never paste code into the Discord console unless you fully understand what every line does, or you completely trust the source.** "A friend told me it was safe" is not enough. "A YouTube tutorial said to" is not enough. "A Discord server told me it would give me free Nitro" is a guaranteed scam.

### Risk 2: This script uses Discord's API in a way Discord doesn't officially allow

Discord's Terms of Service prohibit "self-bots" — automation that performs actions on your account using your user token instead of an official bot account. This script technically falls into that category because it makes search API calls on your behalf in a loop.

**In practice, the risk of action against your account for searching is low** but it is **not zero**. Discord's anti-abuse systems are mostly tuned to catch spamming, mass-DMing, scraping, and raid behavior. A search script that respects rate limits and uses long delays is unlikely to trip those systems. But "unlikely" is not "impossible," and Discord is within their rights to warn, suspend, or ban an account for self-bot activity at any time.

**Recommendations:**

- If you have anything to lose on your main Discord account (Nitro, server ownership, important DMs, friends, server boost streaks), **run this on a secondary or throwaway account instead**.
- Don't run it constantly. Use it when you need it, then close the overlay.
- Don't share your account token with anyone or post console output publicly without redacting it.
- If Discord ever asks you to verify your account or shows unusual security prompts after running this, stop using the script.

### Why this specific script is safe to read and run

You can read every line of [the script](./Discord%20Global%20Search%20Tool%20EXTENSIVE.txt) before running it. It does only the following things:

1. Reads your Discord account token from Discord's own internal storage (the same way Discord reads it itself, no transmission anywhere).
2. Reads the list of servers you're a member of.
3. Builds a draggable overlay UI inside the Discord window.
4. When you click Search, makes HTTP requests to `discord.com/api/v9/guilds/{id}/messages/search` — the same endpoint Discord's own search bar uses — once per page per server, with delays between.
5. Displays the merged results and lets you export them to a CSV file on your computer.

It does **not**:

- Send your token, messages, or any data to any third-party server
- Post messages, join servers, or take any action other than searching
- Persist anything between Discord restarts
- Modify Discord's files or install anything

That said: **don't take my word for it**. The whole point of the warning above is that you should not trust strangers about console scripts. Open the script in a text editor, read through it, and confirm for yourself that the only network requests are to `discord.com` before you paste it. If you don't know JavaScript well enough to verify that, ask someone you trust who does — or don't run it.

---

## What this specific script does

When you paste it into the Discord developer console and press Enter, it adds a draggable overlay to the Discord window with these features:

- **Cross-server search.** Type a query, pick which servers to search, and it pulls every result from every selected server one server at a time.
- **Chronological merging.** All results from all servers are combined and sorted oldest to newest, so you can see the timeline of every mention of the query across your entire Discord life.
- **Click-to-jump.** Clicking any result in the overlay jumps the main Discord window straight to that message in its original channel.
- **CSV export.** One-click download of all current results as a CSV file, including timestamps, server names, authors, message content, and direct links to each message.
- **Server selection.** A 2-column checklist of every server you're in, with Select All / Clear shortcuts.
- **Live progress bar and status line** so you can see which server is being searched and how far along you are.
- **Stop button** to bail out of a long-running search at any time.
- **Automatic 429 recovery.** If Discord rate-limits the search, the script pauses for 20 seconds with a live countdown, then retries the exact page that failed. No data is lost.
- **Collapsible header.** Click the title bar to hide the body of the overlay if you need to see Discord underneath, or use the dedicated Hide button.
- **Draggable.** Grab the title bar and move it anywhere on screen.

---

## Installation

> ⚠️ **You only need to do step 1 once.** After that, you can re-paste the script any time without re-enabling anything.

### Step 1: Open the Discord developer console

Discord's desktop client has a hidden developer console, but you have to enable it first if you've never used it.

1. Open the Discord desktop app on Windows.
2. Click the **gear icon** ⚙ at the bottom left (next to your username) to open User Settings.
3. In the left sidebar, scroll down to **Advanced**.
4. Find **Developer Mode** and turn it **ON**. (This is technically for a different purpose, but it's a good idea to enable it anyway.)
5. Close settings (press Escape or click the X).
6. Press **Ctrl + Shift + I** on your keyboard.

A panel will open on the right side or bottom of the Discord window. This is the developer console. It will look intimidating — that's normal.

### Step 2: Switch to the Console tab

At the top of the developer panel, you'll see a row of tabs: `Elements`, `Console`, `Sources`, `Network`, and so on.

**Click the `Console` tab.**

You will see a **giant red warning** that looks something like this:

> **Stop!**
>
> This is a browser feature intended for developers. If someone told you to copy-paste something here to enable a Discord feature or "hack" someone's account, it is a scam and will give them access to your Discord account.

**Read it.** Take it seriously. The warning is correct. Then continue.

### Step 3: Allow pasting

By default, Discord blocks pasting into the console as an extra safety measure to protect people from scams. You have to type a phrase to confirm you understand what you're doing.

1. **Click anywhere inside the console area** (the big empty space below the warning) so it becomes focused.
2. **Type exactly:** `allow pasting`
3. Press **Enter**.

You should see the text appear and then disappear or get logged. After this, pasting is enabled for the rest of your Discord session.

> If you don't see the "Self-XSS" warning, your Discord version may not require this step. You can skip straight to step 4.

### Step 4: Paste the script

1. Open the script file (`Discord Global Search Tool EXTENSIVE.txt`) in a text editor like Notepad.
2. **Select all** (Ctrl + A) and **copy** (Ctrl + C).
3. Click back into the Discord developer console.
4. **Paste** (Ctrl + V).
5. Press **Enter**.

Within a second or two, the search overlay should appear in the top-right corner of your Discord window. You should also see a message in the console that looks like:

```
[xsearch] Ready: 27 guilds, nav=true
```

If you see that message, **everything worked**. You can close the developer console (Ctrl + Shift + I again) and use the overlay normally.

If you see an error instead, jump to [Troubleshooting](#troubleshooting).

---

## Using the overlay

The overlay has the following parts, top to bottom:

### Title bar

- **Drag** the title bar to move the overlay anywhere on screen.
- **Click** the title bar (not the buttons) to collapse or expand the body. Useful when you want to see what's behind it.
- **Hide / Show button** does the same thing as clicking the title bar.
- **Close button** removes the overlay entirely. To get it back, paste the script again.

### Search box

Type your query here. Same rules as Discord's normal search — words, phrases, etc. Press Enter or click **Search all pages** to start.

### Buttons

- **Search all pages** — starts a full search across every selected server, retrieving every page of results until exhausted.
- **Stop** — interrupts a running search. Results gathered so far are kept and displayed.
- **Export CSV** — saves the current results to a CSV file (see [Exporting results](#exporting-results)).

### Server picker

A 2-column scrollable list of every server you're a member of. Each one has a checkbox.

- **Click a checkbox** to include or exclude that server from searches.
- **Select all** checks every server (this is the default state when the overlay first loads).
- **Clear** unchecks every server.
- **Hover** over a long server name to see the full name in a tooltip.

### Status line and progress bar

While a search is running, the status line shows which server is being searched, what page it's on, and how many results have been collected. The progress bar fills as the search progresses.

### Results

After the search finishes, every matching message appears here, sorted **oldest to newest** across all servers. Each result shows:

- The server name and channel ID
- The timestamp
- The author's username
- The message content

**Click any result** to jump the main Discord window to that exact message in its original channel.

---

## What to expect during a search

Searches are slow on purpose. The script uses long delays between requests to stay well under Discord's rate limits and to look as little like a bot as possible. Here's the timing:

- **2 seconds** between pages within the same server
- **4 seconds** between the last page of one server and the first page of the next

Discord's search API returns 25 results per page. So if a server has 200 matches for your query, that's 8 pages × 2 seconds = 16 seconds for that one server, plus 4 seconds before moving to the next.

**Realistic example:** You search for "pizza" across 20 servers. Most servers have 0–25 matches (1 page each). A few have hundreds (8–10 pages each). Total time: roughly **3 to 8 minutes** depending on how many pages exist.

**Worst case:** Searching a very common word across many large servers can take 20+ minutes.

Use the **Stop button** if it's taking too long. Whatever has been collected so far will still display and be exportable.

### If Discord rate-limits you

If Discord's API responds with a "429 Too Many Requests" error, the script will:

1. Stop immediately.
2. Show a 20-second countdown in the status line.
3. Automatically retry the exact same page that failed.

You don't need to do anything. Just wait. If 429s start happening repeatedly, that's a sign Discord is paying attention to your activity and you should stop using the script for a while.

---

## Exporting results

Click **Export CSV** to download all currently displayed results as a CSV file.

The file is named `discord_search_<your_query>.csv` and gets saved to your default downloads folder (usually `C:\Users\YourName\Downloads` on Windows). From there you can move it to your desktop, open it in Excel or Google Sheets, or do whatever else you want with it.

The CSV has the following columns:

| Column | Description |
|---|---|
| `timestamp` | ISO 8601 timestamp of the message |
| `server` | The name of the server it was posted in |
| `channel_id` | The Discord channel ID (numeric) |
| `author` | The username of the message author |
| `content` | The full text of the message |
| `link` | A direct `https://discord.com/channels/...` link that opens the message |

The file includes a UTF-8 byte order mark, which means Excel will open it correctly without mangling emoji, accented characters, or non-Latin scripts.

---

## Troubleshooting

### "Could not retrieve token"

Discord changes its internal code structure occasionally, and the script's method for finding the token may need to be updated. Open an issue on this repo with the exact error message and your Discord client version (Settings → Advanced → scroll to the bottom).

### "Found 0 guilds"

Same as above — Discord's internal module shape may have changed. Open an issue.

### Nothing happens when I paste

Make sure you typed `allow pasting` (with a space, all lowercase) into the console and pressed Enter first. Some Discord versions require this every time you open the console; others only require it once per session.

### The overlay appears but search returns nothing

- Check that at least one server is selected in the server picker.
- Check that your query isn't empty.
- Open the developer console (Ctrl + Shift + I) and look for red error messages.

### Clicking a result doesn't jump to the message

The script tries multiple navigation methods, but if Discord's internal navigation module has been renamed or hidden, clicks may fail silently. Check the console output — when the script starts, it logs `nav=true` or `nav=false`. If it says `nav=false`, navigation isn't available on your build.

### The popup was blocked

This script doesn't use a popup window — it adds an overlay directly inside Discord, so popup blockers don't apply. If you see a "popup blocked" message, you may be running an older version of the script. Make sure you have the latest one.

### Discord crashed / froze / acted weird

Close Discord completely (right-click the tray icon, Quit Discord) and reopen it. The script doesn't persist anything, so a fresh start clears it entirely.

---

## FAQ

**Does this script send my data anywhere?**

No. Read the script. The only network requests it makes are to `discord.com/api/v9/...` — the same endpoint Discord itself uses. There are no other URLs and no third-party servers.

**Will I get banned for using this?**

Probably not, but it's possible. See [Risk 2](#risk-2-this-script-uses-discords-api-in-a-way-discord-doesnt-officially-allow). Use a secondary account if you have anything to lose.

**Does it work on the browser version of Discord?**

It might, with modifications, but it's designed for and only tested on the Windows desktop client. The "click to jump to message" feature relies on Discord's internal navigation module, which exists on both but may behave differently.

**Does it work on Mac or Linux?**

Probably yes — the desktop Discord clients on Mac and Linux use the same Electron-based codebase as Windows, and the developer console works the same way (though the keyboard shortcut may differ: try Cmd + Option + I on Mac). It hasn't been explicitly tested, though.

**Does it search DMs or group DMs?**

No. The Discord search API endpoint this script uses only works for guilds (servers). DMs would require a different endpoint and aren't currently supported.

**Does it search messages in channels I can't normally see?**

No. The API enforces the same permissions as the Discord client — you can only search channels you have read access to.

**Does it need to be re-pasted every time I restart Discord?**

Yes. The script doesn't persist. If you want it always available, you'd need a client mod like BetterDiscord or Vencord and a plugin wrapper, which is out of scope for this project.

**Can I modify it?**

Yes. It's a single self-contained JavaScript file with no external dependencies. Read it, fork it, change anything you like.

---

## License

Do whatever you want with this. No warranty. If it breaks your Discord, your account, or your computer, that's on you — you read the warnings at the top.
