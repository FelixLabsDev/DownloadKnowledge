# Glossary

The terms below are used with exactly these meanings in code, tests, the UI and the `dk` CLI.

| Term | Meaning |
|---|---|
| **Note** | One piece of knowledge: a set of field values plus tags. Users write notes; they never write cards directly. Table `notes`. |
| **Note type** | Defines a note's fields, its templates and one shared CSS block. Kind is `standard` or `cloze`. Built in: Basic, Basic (and reversed card), Cloze. Table `note_types`. |
| **Field** | A named slot on a note type (`Front`, `Back`, `Text`, `Back Extra`). A note holds one HTML value per field. |
| **Template** | A front and back HTML layout belonging to a note type. Each template of a standard note type generates one card per note. Table `templates`. |
| **Cloze** | A deletion written `{{c1::answer}}` or `{{c1::answer::hint}}` inside a field. Each distinct cloze index generates one card. |
| **Card** | The thing that is scheduled and reviewed: one note seen through one template (or one cloze index). A card lives in a deck and carries the FSRS state. Table `cards`. |
| **Ordinal** | Which card of its note a card is: the template's ordinal for standard note types, the cloze index for cloze. |
| **Deck** | A container for cards. Decks nest. Table `decks`. |
| **Folder** | A deck that has child decks. Not a separate kind of thing; studying it includes everything beneath it. |
| **Deck path** | A deck's full name in Anki's notation, `Parent::Child`. |
| **Review** | One answer to one card, rated Again (1), Hard (2), Good (3) or Easy (4). |
| **Review log** | The insert-only history of reviews. A row's content never changes; undo marks it deleted. Table `review_log`. |
| **State** | A card's FSRS state: new, learning, review or relearning. "Due" counts group learning and relearning together. |
| **Study day** | The 24 hours from 04:00 local time. Daily limits and "due today" are per study day. |
| **Daily limit** | Per deck: how many new cards and how many reviews may be studied per study day. A parent's limit caps everything beneath it. |
| **Desired retention** | Per deck: the recall probability FSRS aims for when it picks the next interval. |
| **Cram** | Studying a deck's cards regardless of schedule. Changes no schedule and writes no review log. |
| **Suspended** | A card flag: the card is kept but never offered for study. |
| **Tag** | A label on a note. Spaces become underscores; matching ignores case. |
| **Media** | An image or audio file referenced from a field, stored once per content hash (sha256). Table `media`. |
| **Outbox** | Local-only table of changes not yet pushed to the server. Every local write appends to it in the same transaction. |
| **Server version** | The server's single increasing counter. Every change the server accepts is stamped with the next value; clients pull "everything after version N". |
| **Device id** | A random id per installation (browser profile, server). Breaks ties in conflict resolution and attributes reviews. |
| **Agent batch** | One run of the `dk` CLI that created notes, recorded so it can be undone as a unit. Table `agent_batches`. |
| **Collection** | The whole dataset of one user, and the class in `packages/core` through which all reads and writes go. |
