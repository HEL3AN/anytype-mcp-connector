// Fills a space with a small, fictional workspace for demos, screenshots and the directory reviewers'
// test account: projects, tasks with due dates and statuses, meeting notes that link to them, a
// collection, a query and a comment. `npm run seed-demo` — writes ONLY to the space named DEMO_SPACE
// (default "API_TEST"). Created ids go to .demo-seed.json; `npm run seed-demo -- --clean` deletes them.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AnytypeClient } from "../src/anytype/client.js";
import { loadConfig, loadEnvFiles } from "../src/config.js";

loadEnvFiles();
const spaceName = process.env.DEMO_SPACE ?? "API_TEST";
const config = loadConfig({ ...process.env, AUTH_DISABLED: "true", HOST: "127.0.0.1", OWNER_PASSWORD: "" });
const api = new AnytypeClient(config.anytypeUrl, config.anytypeApiKey);
const STATE = ".demo-seed.json";

const spaces = (await api.get<{ data: { id: string; name: string }[] }>("/v2/spaces", { limit: 100 })).data.data;
const space = spaces.find((s) => s.name === spaceName);
if (!space) {
  console.error(`No space named "${spaceName}" is visible to this API key. Refusing to run.`);
  process.exit(1);
}
const base = `/v2/spaces/${encodeURIComponent(space.id)}`;

if (process.argv.includes("--clean")) {
  const ids: string[] = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")).ids : [];
  for (const id of ids) {
    try {
      await api.delete(`${base}/objects/${encodeURIComponent(id)}`);
      console.log(`deleted ${id.slice(-6)}`);
    } catch (err) {
      console.log(`could not delete ${id.slice(-6)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  rmSync(STATE, { force: true });
  process.exit(0);
}
if (existsSync(STATE)) {
  console.error(`${STATE} exists: the demo is already seeded. Run with --clean first.`);
  process.exit(1);
}

const created: string[] = [];
const save = () => writeFileSync(STATE, JSON.stringify({ space: spaceName, ids: created }, null, 2));

/** A date `days` from today as YYYY-MM-DD. */
const day = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const mention = (o: { id: string; name: string }) => `<mention object_id="${o.id}">${o.name}</mention>`;

async function create(type: string, name: string, markdown: string, properties: Record<string, unknown> = {}) {
  const res = await api.post<{ id: string }>(
    `${base}/objects`,
    { type, name, markdown, ...(Object.keys(properties).length ? { properties } : {}) },
    { create_missing_options: true },
  );
  created.push(res.data.id);
  save();
  console.log(`${type.padEnd(5)} ${name}`);
  return { id: res.data.id, name };
}

try {
  // --- projects ---------------------------------------------------------------------------------
  const bakery = await create(
    "page",
    "Website redesign — Bluebird Bakery",
    `Client: **Bluebird Bakery**, a neighbourhood bakery with two shops.

## Goals
- Online pre-orders for cakes (pick-up only)
- A menu page the staff can update themselves
- Load in under 2 s on a phone

## Scope
| Phase | What | When |
|---|---|---|
| 1 | Design and content | ${day(-10)} – ${day(4)} |
| 2 | Build and pre-order form | ${day(5)} – ${day(25)} |
| 3 | Launch and handover | ${day(28)} |

## Budget
Fixed price, 3 payments: 30% / 40% / 30%.`,
    { tag: ["Client"] },
  );
  const app = await create(
    "page",
    "Habit tracker app — MVP",
    `Side project: a tiny habit tracker that works offline.

## MVP features
- [x] Daily check-ins
- [ ] Streaks and a weekly chart
- [ ] Reminders
- [ ] Export to CSV

## Open questions
- Native or PWA? Leaning towards a PWA for the first version.
- Pricing: free with a one-time "supporter" unlock?`,
    { tag: ["Personal"] },
  );
  const planning = await create(
    "page",
    "Q4 planning",
    `## Focus for the quarter
1. Ship ${mention(bakery)} on time
2. Get ${mention(app)} to 20 beta users
3. Take one week off in December

## Numbers
- Revenue target: 3 client projects
- Max 30 billable hours a week`,
  );

  // --- tasks ------------------------------------------------------------------------------------
  const tasks: [string, number, string, string[], boolean][] = [
    ["Send the homepage mockups to Bluebird Bakery", -2, "In progress", ["Client", "Urgent"], false],
    ["Collect cake photos from the bakery", -1, "Waiting", ["Client"], false],
    ["Write menu page copy", 1, "To do", ["Client"], false],
    ["Set up the pre-order form prototype", 3, "To do", ["Client"], false],
    ["Invoice: first payment (30%)", 2, "To do", ["Admin"], false],
    ["Choose a PWA framework for the habit tracker", 5, "To do", ["Personal"], false],
    ["Draft the beta invite email", 9, "To do", ["Personal"], false],
    ["Renew the domain for the portfolio site", 12, "To do", ["Admin"], false],
    ["Kickoff call with Bluebird Bakery", -8, "Done", ["Client"], true],
    ["Back up the laptop", -4, "Done", ["Admin"], true],
  ];
  const taskObjects = [];
  for (const [name, due, status, tag, done] of tasks) {
    const project = tag.includes("Personal") ? app : bakery;
    taskObjects.push(
      await create("task", name, `Part of ${mention(project)}.`, { due_date: day(due), status: [status], tag, done }),
    );
  }

  // --- meeting notes ----------------------------------------------------------------------------
  await create(
    "note",
    `Kickoff with Bluebird Bakery — ${day(-8)}`,
    `Attendees: Maria (owner), Tom (shop manager), me.

## Notes
- They want customers to order birthday cakes online, pay in the shop.
- The menu changes every season; staff must be able to edit it without me.
- Photos: they have some, Tom will take new ones in the shop.

## Decisions
- Pick-up only for now, no delivery.
- Launch before the holiday season.

## Action items
- [x] Send a proposal (me) — done
- [ ] Homepage mockups (me) → ${mention(taskObjects[0]!)}
- [ ] Cake photos (Tom) → ${mention(taskObjects[1]!)}`,
  );
  await create(
    "note",
    `Weekly review — ${day(-3)}`,
    `## Went well
- Proposal for ${mention(bakery)} accepted
- Habit tracker: daily check-ins work offline

## Didn't
- Too many small admin tasks on Friday

## Next week
- Mockups to the bakery
- Decide on the PWA framework`,
  );

  // --- a collection, a query and a comment ---------------------------------------------------------
  const col = await api.post<{ id: string }>(`${base}/collections`, { name: "Active projects", items: [bakery.id, app.id] });
  created.push(col.data.id);
  save();
  console.log("list  Active projects");
  const query = await api.post<{ id: string }>(`${base}/queries`, { name: "Open tasks", type: "task", filter: "done = false" });
  created.push(query.data.id);
  save();
  console.log("query Open tasks");

  const discussion = await api.post<{ id: string }>(`${base}/objects/${encodeURIComponent(bakery.id)}/discussion`, {});
  await api.post(`${base}/chats/${encodeURIComponent(discussion.data.id)}/messages`, {
    text: "Maria asked whether the pre-order form can show which cakes need 48 hours' notice.",
  });
  console.log("comment on the bakery project");

  console.log(`\nSeeded ${created.length} objects into "${spaceName}". Remove them with: npm run seed-demo -- --clean`);
} catch (err) {
  console.error(`Seeding stopped: ${err instanceof Error ? err.message : err}`);
  console.error(`Created so far are listed in ${STATE}; remove them with --clean.`);
  process.exit(1);
}
