import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Canned workflows. Clients show them as commands (Claude Code: /mcp__<server>__<name>); each one only
// writes a user message that steers the model through the tools.

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

const inSpace = (space?: string) => (space ? ` in the space "${space}"` : " across my spaces");

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly review",
      description: "Summarize what changed in the workspace recently: progress, open tasks, upcoming deadlines.",
      argsSchema: z.object({
        space: z.string().optional().describe("Space name (default: all spaces)"),
        days: z.string().optional().describe("How many days back (default 7)"),
      }),
    },
    ({ space, days }) => {
      const n = Number(days) > 0 ? Math.floor(Number(days)) : 7;
      return user(
        `Give me a review of my Anytype workspace${inSpace(space)} for the last ${n} days.
1. Find objects changed recently: anytype_search with filter "last_modified_date > daysAgo(${n})", sorted by last_modified_date desc (follow next_offset if needed).
2. Read the relevant ones in batches with anytype_fetch_many (snippets in the search rows help to skip noise).
3. Also look for open tasks with deadlines: e.g. filter "done = false AND due_date IS NOT EMPTY", if the space has those properties (anytype_list_properties).
Then write a short review: what moved forward, what is still open, deadlines in the next two weeks, and anything that looks stuck. Link each item to its object by name. Don't change anything in the workspace.`,
      );
    },
  );

  server.registerPrompt(
    "meeting_to_tasks",
    {
      title: "Meeting notes → tasks",
      description: "Turn the action items of a meeting note into tasks linked back to the note (asks before creating).",
      argsSchema: z.object({
        note: z.string().describe("Name (or id) of the meeting note"),
        space: z.string().optional().describe("Space name, if the note name is ambiguous"),
      }),
    },
    ({ note, space }) =>
      user(
        `Find my meeting note "${note}"${inSpace(space)} (anytype_search, then anytype_fetch) and extract its action items: what, who, when.
Show me the list first and wait for my confirmation. Then create one task per item with anytype_create_object (type task, or the closest type from anytype_list_types), setting assignee/due date properties where they exist, and link each task back to the note with <mention object_id="<note id>">note name</mention> in its body.
Finally add a checklist of the created tasks (as mentions) to the end of the note with anytype_edit_object insert_blocks.`,
      ),
  );

  server.registerPrompt(
    "topic_brief",
    {
      title: "Topic brief",
      description: "Collect everything the workspace knows about a topic into a short brief with sources.",
      argsSchema: z.object({
        topic: z.string().describe("Topic, project or person"),
        space: z.string().optional().describe("Space name (default: all spaces)"),
      }),
    },
    ({ topic, space }) =>
      user(
        `Collect what my Anytype workspace${inSpace(space)} knows about "${topic}".
Search with anytype_search (try a couple of phrasings), read the best hits in batches with anytype_fetch_many, and follow backlinks and links to closely related objects.
Write a brief: key facts, decisions, open questions, and the most relevant objects as a source list (names). Point out contradictions or outdated information. Don't change anything in the workspace.`,
      ),
  );
}
