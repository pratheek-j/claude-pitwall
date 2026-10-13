# 🏎️ Pitwall

An F1-themed pit wall for Claude Code. It sits above the prompt box and shows:

- **CACHE**: how long the prompt cache has left (TTL 1h or 5m), and the cache hit rate.
- **CONTEXT**: how full the context is, measured to where it auto-compacts, with an estimate of laps (turns) left.
- **RACE**: progress toward your goal, from the last Radio check.
- **Lap timer, flag and session cost** in the header. Hover the flag for why it is that color and what to do.

Buttons:

| Button | What it does |
|---|---|
| 📋 Handoff | Writes a detailed handoff (or, with **✏️ With a focus…** / `/handoff <focus>`, one tailored to what the next session will do) to `.handoff/` (git-ignored), including the skills the next session should use. The resume prompt then shows on the strip with a **📋 Copy** button. |
| 🔧 Compact | Compacts the conversation, between turns. |
| ✅ Self commit | Lists uncommitted changes in your repo(s) and asks Claude, in the chat, for a commit message per repo. Claude does not commit. |
| 🔥 Grill me | Runs `/mattpocock-skills:grilling` on the current plan, or **✏️ Pick a topic…** to type one in the prompt box. Needs the [mattpocock skills](https://github.com/mattpocock/skills) plugin. |
| 🧒 ELI5 | Explains the last answer, or the whole session, like you're 5: plain words, an analogy, tiny examples. |
| 📻 Radio check | Summary, progress and 3 next questions. |

Also: a **safety car** that saves a Handoff just before Claude Code auto-compacts, sounds and desktop notifications, and a **? legend** explaining everything.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install pitwall --marketplace pratheek-j/claude-pitwall
```

Answer `y` to add the marketplace, then pick the **user** scope. Pitwall then loads in every session, the desktop app's Code tab included.

## Commands

`/handoff [focus]`, `/resume-handoff`, `/self-commit`, `/eli5 [session]`, `/are-we-there-yet`, `/pitwall-sound`, `/pitwall-notify`

## Platform notes

- Sounds play with `paplay`, `pw-play` or `aplay` on Linux, and Claude Code's own player on macOS, at 30% of the system volume.
- Desktop notifications use `notify-send` on Linux and `osascript` on macOS.

## Credits

Team radio and fly-by sounds are trimmed from Pixabay clips, used under the [Pixabay Content License](https://pixabay.com/service/license-summary/):
[f1_radio_sound](https://pixabay.com/sound-effects/film-special-effects-f1-radio-sound-293747/) by u_dn8ylcpe3v and
[Monza track side](https://pixabay.com/sound-effects/film-special-effects-monza-track-side-69992/) by freesound_community.
The pit stop sound is synthesized.
