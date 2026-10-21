# LikeC4 architecture diff

A GitHub Action that shows the reviewer of a pull request what it changed in the
[LikeC4](https://likec4.dev) architecture model. It compares the model of the pull request with
its base and comments with each view that changed, as Mermaid that GitHub renders in place:

- added elements and relationships in green
- changed ones in amber
- removed ones in red, in a *before* diagram of the base

A change to a description, a technology or a view's include rules counts; a renamed or moved
element shows as removed and added. Views that did not change are left out, and a pull request
that changes no view gets no comment, or its earlier comment says so. The colours read in GitHub's light and dark themes.

```mermaid
---
title: "API"
---
graph TB
  subgraph ShopApi["`API`"]
    ShopApi.Orders@{ shape: rectangle, label: "Orders" }
    ShopApi.Billing@{ shape: rectangle, label: "Billing" }
    ShopApi.Mail@{ shape: rectangle, label: "Notifications" }
  end
  ShopApi.Orders -. "`charges`" .-> ShopApi.Billing
  ShopApi.Orders -. "`sends receipt`" .-> ShopApi.Mail
  style ShopApi fill:#8c959f1f,stroke:#8c959f
  style ShopApi.Mail fill:#2da44e33,stroke:#2da44e,stroke-width:3px
  linkStyle 1 stroke:#2da44e,stroke-width:3px
```

## Usage

```yaml
name: architecture-diff

on:
  pull_request:
    paths: ['docs/architecture/**']

permissions:
  contents: read
  pull-requests: write

jobs:
  architecture-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: novibe-org/likec4-architecture-diff-action@v1
```

The `paths` filter runs it only on pull requests that touch the model. It updates its own comment
on each push instead of adding a new one. A pull request from a fork has a read-only token, so
there the diff goes to the job summary only.

## Inputs

| Input | Default | |
|---|---|---|
| `path` | `docs/architecture` | Directory with the LikeC4 model |
| `likec4-version` | `1.60.0` | Version of the [`likec4`](https://www.npmjs.com/package/likec4) package to run |
| `github-token` | `${{ github.token }}` | Token that comments on the pull request |

## How it works

`likec4 export json` gives the model of both sides, and the diff is taken on that model, not on
pictures. `likec4 gen mermaid` renders the views, and the action adds a style line for each
element and relationship that changed. Nothing is hosted: the Mermaid sits in the comment.

Part of [NoVibe](https://github.com/novibe-org/novibe).

## License

[Apache 2.0](LICENSE)
