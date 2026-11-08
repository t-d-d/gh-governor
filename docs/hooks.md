# Hooks

A hook lets a system outside GitHub, such as a cloud alarm, start a session in the repo. The repo lists the hook in its file, and the caller sends governor one HTTPS request signed with that hook's key. The request carries data. The prompt is the file's, so a pull request reviews what the session is told.

This page is for a hook's caller, and for the owner who mints its key. The `hooks.sessions` a repo keeps in its file is in [the config reference](config-reference.md#hooks).

**The request.** `POST <receiver URL>/hooks/<owner>/<repo>/<hook>`, where the receiver URL is the stack's `WebhookUrl` output, with a JSON body and one header:

```
POST /hooks/acme/factory/operator-prod
Content-Type: application/json
Governor-Signature: v=1,t=1790000000,sha256=<hex>

{"text":"ALARM: api 5xx over threshold"}
```

- `text` is plain text, at most 32 KiB. Send the alarm's summary, not its whole payload.
- `v` is the key version, `t` the time in Unix seconds, and the hex is the HMAC-SHA256 of `<t>.<raw body>`, keyed with the key's hex digits as text. Sign the exact bytes you send.
- `t` must be no more than 30 seconds ahead of governor's clock and no more than 4 minutes 10 seconds behind it, so sign with the current time. The same request sent twice inside five minutes is one fire, and a request stays valid for 4 minutes 40 seconds, a margin under those five minutes at least as long as the receiver's timeout, so a replay never starts a second session.

In Node:

```js
import { createHmac } from 'node:crypto';
const [version, key] = process.env.GOVERNOR_HOOK_KEY.slice(1).split('.'); // the stored value, v<version>.<hex>
const url = process.env.GOVERNOR_HOOK_URL; // the hook's full URL, as scripts/hook-key.mjs saved it
const body = JSON.stringify({ text });
const t = Math.floor(Date.now() / 1000);
const sha256 = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'governor-signature': `v=${version},t=${t},sha256=${sha256}` } });
```

The known answer in test/dispatch-hook.test.ts checks a caller's code: under the hook secret `hook-secret-fake`, `acme/factory`'s `operator-prod` at version 1 has the key `205f2b1f…`, and that test gives the header for one body and time.

**The answers.**

| Answer | Meaning |
|---|---|
| `202` | The fire was queued. |
| `200` | The repo's owner is not on the deployment's owner list. Nothing was queued. |
| `400` | The body is not JSON, or holds no string `text`. |
| `401` | The header is missing or malformed, the signature does not match, or `t` is more than 30 seconds ahead of governor's clock or more than 4 minutes 10 seconds behind it. Also a hook the repo's file did not list when governor last read it, or a key version older than the one it named. |
| `404` | The path under `/hooks/` names no repo and hook. |
| `413` | The text is over 32 KiB, or too long to start a task with. |
| `429` | The hook has had its `perHour` fires this clock hour. Nothing was queued: send it next hour, or not at all. |
| `503` | Governor could not read what it knows of the repo's hooks, or could not count the fire. Nothing was queued: send it again. |

Governor reads the repo's file on its own schedule and on GitHub events, and keeps the list of hooks, key versions and caps it last read where the receiver can check it. So a new hook answers `401` until governor next reads the file, a raised `keyVersion` turns the old key away at the receiver from then on, and a changed `perHour` holds from then on. Before governor has read the file at all, every signed request is queued, up to 20 an hour per hook.

A `202` means queued, not started. The task then refuses a fire whose repo turns `hooks` off or lists no hook of that name, logged at warn, and one signed with a key version other than the hook's `keyVersion`, which pages as `governor-hook-key-stale`. Otherwise, if the hook's last session is still open, the fire goes into it as a message: governor's relay line naming the hook, then which hook fired and when, the caller's text quoted as the caller's data. It carries no standing line, since a hook's fire is not a close, a merge or a deploy. So one session covers a burst of alarms. Once that session has signed off and been archived, or archived by hand, the next fire starts a new session in the repo's environment. A fire for one hook never reaches another hook's session.

**Minting a key.** Each hook's key is derived from the stack's secret `governor/hook-secret`, the repo, the hook's name and its key version, so governor stores no key. The owner runs the key script once per hook, after the pull request that adds the hook has merged. It needs an AWS identity that may read that secret and the stack's outputs, and the `gh` CLI logged in as an admin of the repo:

```bash
node scripts/hook-key.mjs --repo acme/factory --hook operator-prod --env prod [--profile <p>] [--stack governor]
```

The `prod` environment of `acme/factory` then holds the secret `GOVERNOR_HOOK_KEY`, the key as `v<version>.<hex>`, and the variable `GOVERNOR_HOOK_URL`, the hook's full URL. The key never appears on screen. The script reads the key version from the hook's `keyVersion` in the file on the default branch, and the URL from the stack's `WebhookUrl` output. It writes to an environment that exists and creates none: a name it cannot find fails the run and lists the ones there are. `--key-name` and `--url-name` change the two names. `--version <n>` mints that version without reading the file.

An owner who is not an admin of the repo leaves out `--env`. The script then prints the key alone on stdout, and on stderr the hook's URL and the two commands that save both values. Whoever runs them needs admin on the repo and the same AWS access, since the first runs the script again. The first saves the key only when that run succeeds, so an expired AWS session cannot replace a working key with an empty one:

```bash
(key="$(node scripts/hook-key.mjs --repo acme/factory --hook operator-prod)" && printf '%s' "$key" | gh secret set GOVERNOR_HOOK_KEY --repo acme/factory --env <environment>)
gh variable set GOVERNOR_HOOK_URL --repo acme/factory --env <environment> --body <hook URL>
```

Rotating `governor/hook-secret` replaces every hook's key at once.

**Revoking a key.** Raise the hook's `keyVersion` in the file in a pull request and merge it. Until governor next reads the file, the task refuses each fire signed with the old key. After that read, the receiver answers each one `401` before it reaches the queue. Either way each one logs `hook-key-stale` and pages as `governor-hook-key-stale`. Then mint the new version's key and give it to the caller. The repo's other hooks keep working throughout. To retire a hook, remove it from the file: once governor has read the file, the receiver answers its caller `401` and logs it at warn, which pages nobody.
