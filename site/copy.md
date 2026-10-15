# Landing page copy

Every word on the page, in page order. Each heading names a slot in
`template.html`, and the text under it fills that slot. Lines starting with a
dash make a list. Backticks set code, asterisks or underscores set emphasis,
and `[text](https://…)` makes a link. A blank line starts a new paragraph. Run
`npm run site` to rebuild.

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

## hero.headline

How am I supposed to review all this

## hero.lede

What if your PR review tools showed you *this* instead of a code diff:

## hero.shot.alt

Backstory's map: four components touched, page shell, map strip, flow engine and model reader, each with its changed files and line counts. 

## hero.shot.caption

This is a real branch. 1,611 lines of code and here's what changes in the system.

## why.sub

AI can write PRs faster than I can understand them, but I'm still responsible for what ships. If our job as software engineers is increasingly about design and architecture, why do our PR review tools still just show us a code diff? 

What if our PR review tools answered these questions for us:

- What parts of the system does this change touch?
- What does each user action do now?
- What happens to the data?

We've used sequence diagrams and C4 maps for decades; why not use them to help us understand code changes?

## basics.heading

What might a PR review tool for 2026 look like?

## map.label

Help understand the architecture

## map.heading

See where things have changed

## map.body

A [C4 map](https://www.youtube.com/watch?v=x2-rSnhpw0g) highlights the components the change touches. See how it fits into the system before digging into individual files.

## map.shot.alt

A close-up of the map: the map strip, the flow engine and the model reader, which has two new files, route.ts and draft.ts.

## flows.label

Help understand the flows

## flows.heading

Understand the data flow and API

## flows.body

A sequence diagram for each user action. I want to know the calls between components and what data passes between them.

## flows.shot.alt

A Backstory flow: a 12-step sequence diagram of what happens when the user clicks "Draft a model".

## data.label

Help understand the data model

## data.heading

Data models are tricky

## data.body

A flaw in the data model layer is what bites us in the butt later, so our PR review tools should show us the changes to entities, fields and relationships before we merge.

## data.shot.alt

Backstory's data view on a Mastodon pull request, "Add email subscriptions": a new EmailSubscription entity with four new fields, confirmation_token, confirmed_at, email and locale, linked to the existing Account.

## close.heading

Would you review a PR this way?

## close.body

I'm playing around with this concept to get me up to speed quickly when a change needs my attention.

I'd love your take: would this help you judge a change? What would you still need before you'd merge?

## cta.download

Download for Mac

## cta.star

Star on GitHub
