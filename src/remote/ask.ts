// ask_user_question for headless runs on the Sprite. Same name and question shape as
// @juicesharp/rpiv-ask-user-question (not loaded on the Sprite: two tools with the
// same name stop pi from starting). Options are optional, so open questions work.
// The questions go to question.json and the run ends with no extra model turn;
// handoff-run then reports needs_input and the answer arrives via /handoff reply.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Short option label" }),
  description: Type.String({ description: "What choosing this option means" }),
  preview: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: "The full question" }),
  header: Type.String({ description: "Short tag for the question" }),
  options: Type.Optional(Type.Array(OptionSchema, { maxItems: 4 })),
  multiSelect: Type.Optional(Type.Boolean()),
});

export function createAskTool(jobDir: string) {
  return defineTool({
    name: "ask_user_question",
    label: "Ask User (handoff)",
    description:
      "Ask the user one or more questions. The user is not watching this run: the questions are delivered as a notification, this run ends, and their answer arrives as the next user message.",
    promptSnippet: "Ask the user; ends the current run until they reply",
    promptGuidelines: [
      "Only ask when you cannot reasonably proceed. Prefer a sensible default and note it in your summary.",
      "Calling ask_user_question ends this run. Put everything the user needs to decide in the question itself, and commit and push your work first.",
    ],
    parameters: Type.Object({
      questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
    }),
    async execute(_toolCallId, params) {
      writeFileSync(
        join(jobDir, "question.json"),
        `${JSON.stringify({ askedAt: new Date().toISOString(), questions: params.questions }, null, 2)}\n`,
      );
      return {
        content: [
          {
            type: "text",
            text: "Questions delivered to the user. This run ends now; their answer will arrive as the next user message.",
          },
        ],
        details: { questions: params.questions },
        terminate: true,
      };
    },
  });
}
