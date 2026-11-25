# Realtime

Notes for agents that work in this repository.

## Writing for people

The preferred style for text that people read: pages, docs, pull request descriptions, replies, and prompts for other agents.

- Use plain STE100 English with contractions.
- Leave out AI jargon and cheesy or inspirational phrasing.
- Stay away from rules, laws and absolutes, such as "every", "always", "never" and "the four rules". It's a common AI trap. Describe how things tend to work.
- Keep it high level and friendly, with enough technical detail to hold a reader.

This is about tone in writing. It doesn't loosen the working constraints in this file.

## Keep the code app-neutral

This repository takes an app as input and doesn't know which app it is. Code, tests, docs and manifests don't name a specific app. `typescript/packages/core/test/product-names.test.ts` checks this and fails when a tracked file contains a name from its list.

## Comments

Code comments tend to repeat the code, go stale, or excuse a shortcut, so the `realtime/no-comments` oxlint rule (`lint/comments.mjs`, `bun run lint` in `typescript/`) bans them. It allows a decision record that starts with `Decision:`, tool directives such as `@ts-expect-error <why>`, and JSDoc on the published API in `typescript/packages/*/src`. `/delete-comment` (`.claude/skills/delete-comment`) walks through an audit.

## Lint

`bun run lint` in `typescript/` runs oxlint with `lint/oxlint.config.ts`. The config extends bwf's shared lint config (`@builtbyfriends/bwf/lint`), so this repository runs the same checks as the others. That config starts from Cloudflare's type-aware preset (`@cloudflare/oxlint-config`), whose `quality/*` rules catch type shortcuts such as `as unknown as T`, `object` parameters and `Record<string, unknown>`, and adds Dillon Mulroy's anti-slop rules, the "You might not need an effect" rules, the React Compiler rules, React Doctor and limits on complexity, depth and function size. On top of it this repository adds the comment rule, and turns a rule to `warn` while older code still has reports. The demos in `bwf/` lint with `lint/oxlint.demos.config.ts`, the same rules without type information, because their dependencies aren't installed.

The lint packages install into `lint/` with bun, so the npm lockfile in `typescript/` stays as it is. A rule that doesn't fit some files is turned off for them in the config with a `Decision:` line. A cast the code needs at a boundary gets an `oxlint-disable-next-line <rule> -- <reason>`.
