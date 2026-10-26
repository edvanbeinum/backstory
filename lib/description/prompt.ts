/**
 * The change description's question to the AI provider: its JSON schema, and
 * the prompt with the writing rules that keep the answer specific. The
 * schema lives here alone, so a later read that adds to it changes one file.
 */

/** What the provider answers */
export interface DescriptionOutput {
  what: string;
  why: string | null;
  lookFirst: { name: string; reason: string }[];
  components: { name: string; sentence: string }[];
}

/** At most this many places to look first */
export const LOOK_FIRST_MAX = 2;

export const descriptionSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["what", "why", "lookFirst", "components"],
  properties: {
    what: { type: "string" },
    why: { type: ["string", "null"] },
    lookFirst: {
      type: "array",
      maxItems: LOOK_FIRST_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason"],
        properties: {
          name: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "sentence"],
        properties: {
          name: { type: "string" },
          sentence: { type: "string" },
        },
      },
    },
  },
});

export const WRITING_RULES = [
  "Lead with the point: the first words say what changed.",
  'Use the real names given: components, entities, screens, functions. Not "various parts of the system".',
  "Put names from the code in backticks: functions, types, fields, files. Component and entity names stay plain.",
  'Plain, literal words. None of "seamless", "robust", "leverage", "enhance", "streamline", "carries", "holds". No metaphors or colloquialisms.',
  'No openers like "This change…" or "This PR…", and no closing summary.',
  "Each sentence says one thing. A sentence that could describe any change is cut.",
  "When the change gives stored data a lifecycle, such as a value moved from one slot to another or a status that moves through states, what says so in one sentence, naming the slots or states.",
  "why comes only from the commit messages and the pull request. When they don't say why, it is null. Never guess it from the code.",
  `lookFirst names come only from the lists of components and entities given, copied exactly. At most ${LOOK_FIRST_MAX}, chosen for where a reviewer is most likely to find a mistake.`,
  "components names come only from the list of components given, copied exactly, each once.",
];

export const GOOD_EXAMPLES = [
  "Retries a failed upload in Sync Engine three times in `uploadOrder`, waiting longer each time, before it marks the order as unsynced.",
  "Saves the shopper's Basket when they sign out and loads it again on their next sign-in.",
];

export const BAD_EXAMPLES = [
  "To ensure a smoother experience, this change enhances the sync logic across various parts of the system.",
  "This PR makes several improvements to how baskets are handled, resulting in a more robust checkout.",
];

export interface DescriptionInputs {
  patch: string;
  /** `git diff --stat`, when the patch was cut at the cap */
  stat: string | null;
  messages: string;
  pr: { title: string; body: string } | null;
  /** Names of the components the change touches; null when the repo has no map yet */
  components: string[] | null;
  /** Names of the entities the change touches */
  entities: string[];
}

const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

const named = (items: string[] | null, none: string) =>
  items === null ? none : items.length ? list(items) : "None.";

export const descriptionPrompt = (inputs: DescriptionInputs) =>
  `You are describing one change to a repository for the person about to review it. The code at the end of the change is in the current directory: read files with Read, Grep and Glob when the patch is unclear. Don't modify anything.

Answer in four parts:
- what: one or two sentences saying what the change does.
- why: one or two sentences saying why the change was made, or null.
- lookFirst: the places a reviewer should look first, each a name and a one-sentence reason.
- components: for every component the change touches, its name and one sentence saying what the change does in it. Empty when there are no component names.

Every sentence, in every part, follows the writing rules.

Writing rules:
${list(WRITING_RULES)}

Good sentences:
${list(GOOD_EXAMPLES)}

Bad sentences:
${list(BAD_EXAMPLES)}

Components the change touches:
${named(inputs.components, "This repo has no map yet, so there are no component names.")}

Entities the change touches:
${named(inputs.entities, "None.")}

The branch's pull request, which may cover more than this change; describe only what the patch does:
${inputs.pr ? `${inputs.pr.title}\n\n${inputs.pr.body.trim() || "(No description.)"}` : "None."}

Commit messages:
${inputs.messages.trim() || "None."}
${
  inputs.stat === null
    ? ""
    : `
The patch is too large to send whole. Here is every file it changes, then the patch cut short; read the files here for the rest:
${inputs.stat}
`
}
The patch:
${inputs.patch}`;
