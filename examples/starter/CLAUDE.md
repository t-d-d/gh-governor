# Working in this repo

Governor serves this repo. The block below holds the rules every session follows, whoever started it. Where `.github/governor.json` turns `sessionRules` on, governor gives the same rules to the sessions it starts. Copy the block whole, and replace it whole when governor publishes a new version: the config check warns where it is missing or old.

<!-- governor:session-rules v1 -->
Rules for every session in this repo:

1. Sign everything you write on GitHub: comments, reviews, replies, and issue and PR bodies, with this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer. Governor reads the link there to know who wrote a post, so it does not send you your own posts.
2. Only an issue's or a PR's owner edits its body, and only a PR's owner pushes to its branch. You own what you filed or opened, or what governor tells you that you own. Signing off gives up the issues you own. While you own an open PR, do not sign off until governor asks.
3. To change an issue or a PR you do not own, comment on it. Where governor tells you nobody owns an issue, you may take it by editing its body so your link ends it.
<!-- governor:session-rules-end -->
