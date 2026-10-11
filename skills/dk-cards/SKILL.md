---
name: dk-cards
description: Create, search, edit, move and delete flashcards and decks in the owner's DownloadKnowledge spaced-repetition app, using the dk command-line tool over SSH. Use when asked to make flashcards or cards from some material, add something to a deck, or tidy up decks and cards.
---

# DownloadKnowledge cards

DownloadKnowledge is the owner's personal Anki-style study app. Its server has a CLI, `dk`, that you run over SSH. Whatever you write appears on the owner's phone and desktop at their next sync (within about a minute while the app is open).

## Running commands

```
ssh linux-machine docker exec -i dk dk <command>
```

- Keep `-i`: some commands read JSON from stdin.
- Every command prints JSON. On failure it prints `{"error": "...", "code": "..."}` to stderr and exits non-zero.
- `dk --help` lists everything.
- **Never touch the database with SQL or by editing files.** A row written that way is not stamped for sync and never reaches any device, and a note written that way gets no cards.

## The model

- A **note** is one piece of knowledge: named fields plus tags. You write notes.
- A **card** is what gets studied. Notes generate cards: a Basic note makes one, a reversed note two, a cloze note one per numbered gap.
- A **deck** holds cards. Decks nest; a path is written `Parent::Child`.

Note types and their fields (`dk note-types list` shows the current set):

| Type | Fields | Cards |
|---|---|---|
| `Basic` | `Front`, `Back` | 1: Front → Back |
| `Basic (and reversed card)` | `Front`, `Back` | 2: Front → Back and Back → Front |
| `Cloze` | `Text`, `Extra` | 1 per cloze number in `Text` |

Fields are HTML. Plain text is fine; use `<br>` for a line break, `<b>`, `<i>`, `<ul><li>` for emphasis and lists. A cloze gap is `{{c1::hidden text}}` or, with a hint, `{{c1::hidden text::hint}}`.

## Adding cards

1. Look at what exists so you match the owner's deck names and avoid repeats:
   ```
   ssh linux-machine docker exec -i dk dk decks list
   ssh linux-machine docker exec -i dk dk cards search 'deck:"Languages::Spanish"' --limit 20
   ```
2. Send a JSON array on stdin. `--deck` and `--description` are required; the deck is created if it does not exist.
   ```
   ssh linux-machine docker exec -i dk dk notes add --deck "Biology::Cells" --description "Chapter 3: organelles" --tags ch3 <<'EOF'
   [
     { "fields": { "Front": "What does the mitochondrion produce?", "Back": "ATP, by cellular respiration" } },
     { "type": "Cloze", "fields": { "Text": "Ribosomes are made in the {{c1::nucleolus}}." } },
     { "type": "Basic (and reversed card)", "fields": { "Front": "organelle", "Back": "a specialised structure inside a cell" }, "tags": ["vocab"] },
     { "deck": "Biology::Plants", "fields": { "Front": "Where does photosynthesis happen?", "Back": "In the chloroplasts" } }
   ]
   EOF
   ```
   Per note you may set `type`, `tags` and `deck`; otherwise the command's `--type` (default `Basic`), `--tags` and `--deck` apply.
3. Read the result. `added` lists what was created; `skipped` lists notes left out because the same first field already exists in that deck. Skipping is the safe default; pass `--allow-duplicates` only if the owner asked for repeats. If any note is invalid the whole batch is rejected and nothing is added; the error names the note by position.
4. Tell the owner the deck, how many notes and cards were added, how many were skipped, and the `batchId`.

Each run is one **batch**. Its notes carry the `agent` tag and the batch id, so the owner can review them (`tag:agent` in the app's browser) and you can undo the run as a unit:

```
ssh linux-machine docker exec -i dk dk batches list
ssh linux-machine docker exec -i dk dk batch undo <batchId>
```

Write a `--description` the owner will recognise weeks later ("Ch. 3 organelles from the lecture PDF"), not "cards".

## Writing good cards

- **One fact per card.** If the answer has "and" in it, split it.
- **Lists become cloze notes**, one gap per item, in a single note: `The three states of matter are {{c1::solid}}, {{c2::liquid}} and {{c3::gas}}.` Never put a whole list on the back of a Basic card.
- **Questions must have one clear answer.** "What does the mitochondrion produce?" not "Tell me about mitochondria."
- **Keep answers short**: a word, a phrase, one sentence. Put background in `Extra` (cloze) or after a `<br>` on the back.
- **Give context on the front** so the card stands alone months later: "In HTTP, what does status 304 mean?" not "What does 304 mean?"
- **Reversed notes only for true pairs** (vocabulary, symbol ↔ name), where recalling in both directions is the point.
- **Do not invent facts.** Take cards from the material the owner gave you; if you add something from your own knowledge, say so when you report.
- Prefer 10 good cards to 40 thin ones. Ask before adding more than about 50 notes in one go.

## Finding and changing things

```
dk cards search <query> [--limit N] [--offset N]
```

Query words match field text. Filters: `deck:Name` or `deck:"A::B"` (includes sub-decks), `tag:x`, `note:Cloze`, `is:new|learn|review|due|suspended`. Prefix a filter with `-` to negate it. Results give `cardId`, `noteId`, `deck`, `fields`, `tags`, `state`, `due`.

| To | Command |
|---|---|
| Edit a note | `dk notes edit <noteId>` with `{"fields": {"Back": "new text"}, "tags": ["a", "b"]}` on stdin. Only the fields you name change; `tags` replaces the whole list. Cards are re-generated to match (a new cloze number adds a card; a removed one deletes its card). |
| Move cards | `dk cards move --deck "A::B" <cardId>...` |
| Suspend / unsuspend | `dk cards suspend <cardId>...` / `dk cards unsuspend <cardId>...` |
| Delete notes | `dk notes delete <noteId>...` (deletes all of each note's cards) |
| Create a deck | `dk decks create "A::B::C"` |
| Rename a deck | `dk decks rename "A::B" "New name"` |
| Move a deck | `dk decks move "A::B" "Other parent"` or `dk decks move "A::B" --top` |
| Delete a deck | `dk decks delete "A::B"` (also its sub-decks and all their cards) |

## Care

- Deletes are soft: the app's server keeps deleted rows for 30 days, but there is no CLI command to restore them, so treat a delete as final. Confirm with the owner before deleting a deck or more than a handful of notes they wrote themselves.
- Editing a note's fields does not reset its schedule. Do not delete and re-add a note to change it; that throws away the owner's review history.
- You cannot review cards, change scheduling or read review history through this tool.
- Shell quoting: deck paths contain `::` and often spaces, so quote them. With the heredoc form above, use `<<'EOF'` (quoted) so `$` and backticks in card text are not expanded.

## Installing this skill

For Claude Code, copy this folder to `~/.claude/skills/dk-cards/` (available in every project) or to `.claude/skills/dk-cards/` in a project. The machine running the agent needs the `linux-machine` SSH alias.
