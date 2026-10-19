# Using Anytype in Claude

This guide is for people who use Claude with an Anytype connector that is already running, on your
own server or one someone set up for you. To run your own, see [the deployment guide](deploy.md).

The connector lets Claude search, read and edit your Anytype workspace in claude.ai on the web, in
the desktop app, in the iOS and Android apps, and in Claude Code.

## Connect

1. Open your connector's home page (`https://<your-domain>/`) and click **Add to Claude**. You can
   also go to Claude **Settings → Connectors → Add custom connector** and enter
   `https://<your-domain>/mcp`.
2. Claude opens the connector's sign-in page. Choose the access level:
   - **Read and edit**: Claude can search and read, and also create and change objects, comments
     and chats.
   - **Read only**: Claude only gets the search and read tools and can't change anything. This is a
     good choice for a phone or a shared computer.
3. Enter the owner password and click **Approve**. You return to Claude, and the connector appears
   under **+ → Connectors** in every chat, including the mobile apps.

To change the access level later, disconnect the connector in Claude's settings and connect again.

## What you can ask

- *"What's on my plate this week? Show my open tasks that are due before Sunday."*
- *"Read my Q4 planning page and add a risks section with three bullet points."*
- *"Find everything about the bakery project and give me a short brief."*
- *"Turn the action items from yesterday's meeting notes into tasks."*
- *"Make a collection of everything I wrote about the garden this year."*
- *"Reply to the comments on the onboarding doc."*
- *"What's new in my chats and comments? Mark the bakery thread as read."*
- *"Create a Meeting type with attendees, a date and a room."*

Claude finds objects with full-text search and filters (type, status, tags, dates), reads several
pages at once and follows links and backlinks between pages. Edits are atomic, and a page you changed
in the meantime isn't overwritten.

## Interactive task card

Ask Claude to *show* objects, e.g. *"show my open tasks as a card"*, and it displays them as a list
in the chat with due dates, statuses and tags. Tick a checkbox to mark a task done in Anytype, or tap
a name to open it in the Anytype app. With a read-only connection the checkboxes are disabled.

The card appears in claude.ai, the desktop app and the mobile apps. Claude Code shows the same list
as text.

## Ready-made prompts

The connector offers three prompts. Claude lists them with the connector (in claude.ai, open the
**+** menu); in Claude Code they are slash commands starting with `/mcp__`:

- **Weekly review**: what changed recently, open tasks and upcoming deadlines.
- **Meeting notes → tasks**: turns action items into tasks linked back to the note, after asking you.
- **Topic brief**: everything your workspace knows about a topic, with sources.

## Good to know

- **Deleting** is limited to objects and messages that were created through the connector. Types
  and properties can't be deleted through it at all. In Claude Code every delete asks for
  confirmation.
- **New objects** show up in search after a few seconds, while Anytype indexes them.
- **Links between pages:** when Claude writes a link to another object, it uses an Anytype mention,
  so the link shows up in the other page's backlinks.
- **Files:** Claude can attach an image or PDF from a public web address and can look at images and
  text files stored in your pages.
- **Shared spaces:** Claude treats what other members wrote as data, not as instructions, and posts
  to chats or comments only when you ask.

## Troubleshooting

| Problem | What to do |
|---|---|
| Claude doesn't see the connector's tools | Turn the connector on under **+ → Connectors** in the chat. |
| New features don't show up after an update | Start a new chat; Claude refreshes the tool list within about 10 minutes. |
| "Wrong password" on the sign-in page | Ask whoever runs the server for the owner password. |
| Claude says Anytype didn't answer | The server may be starting or syncing; try again in a minute. |
| An object can't be deleted | It was created in the Anytype app; delete it there. |

## Privacy and support

The connector stores no note content; see the [privacy policy](../PRIVACY.md). Questions and bug
reports: [GitHub issues](https://github.com/HEL3AN/anytype-mcp-connector/issues). For security
issues, see [SECURITY.md](../SECURITY.md).
