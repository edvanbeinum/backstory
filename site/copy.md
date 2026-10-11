# Landing page copy

Every word on the page, in page order. Each heading names a slot in
`template.html`, and the text under it fills that slot. Lines starting with a
dash make a list. Backticks set code, and asterisks or underscores set
emphasis. A blank line starts a new paragraph. Run `npm run site` to rebuild.

## page.title

Backstory

## brand.owner

edvanbeinum /

## brand.name

backstory

## nav.watch

Watch

## nav.star

Star

## hero.label

What does it even mean to review a PR?

## hero.headline

Feeling guilty about not reading diffs anymore?

## hero.lede

Yeah, me too. There's too much code to read, and I'm still responsible for all of it.

If our job is now design and architecture, shouldn't PR review look like this?

## cta.star

Star on GitHub

## cta.watch

Watch for the first release

## hero.shot.alt

Backstory's map: four components touched, page shell, map strip, flow engine and model reader, each with its changed files and line counts. Below sit Claude Code, the state directory and the git reader.

## hero.shot.caption

A real branch: the parts of the system it touches, not the 1,611 lines it adds.

## why.heading

We still can't trust an LLM to design a solid (arf) system.

## why.sub

So review the design instead:

- What parts of the system does it touch?
- What does each action do now?
- What happens to the data?

## basics.heading

Backstory answers all three.

## map.label

The architecture

## map.heading

Get context on which parts of the system the change affects

## map.body

Get context for which part of the system changed int your actual human brain quickly with a C4 diagram of the system, with every changed component shown.

## map.shot.alt

A close-up of the map: the map strip, the flow engine and the model reader, which holds two new files, route.ts and draft.ts.

## flows.label

The flow

## flows.heading

What it does

## flows.body

A sequence diagram for each user action the change affects

## flows.shot.alt

A Backstory flow: a 12-step sequence diagram of what happens when the user clicks "Draft a model".

## data.label

The data model

## data.heading

What it changes underneath

## data.body

The data model is hardest thing to change later. So lets show that clearly, including what fields changes and the relationships.

## data.shot.alt

Backstory's data view on a Mastodon pull request, "Add email subscriptions": a new EmailSubscription entity with four new fields, confirmation_token, confirmed_at, email and locale, linked to the existing Account.

## close.heading

Here's Backstory.

## close.body

The code's still there when you want it. You just don't start with it. Not released yet: star the repo to follow along.

## footer.left

Backstory · understand the change, not the code

## footer.right

Screenshots: Backstory reviewing one of its own branches, and a Mastodon pull request
