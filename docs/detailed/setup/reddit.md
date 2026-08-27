# Reddit

```console
$ lanes link connect reddit --profile personal --target local
```

Reddit is the one provider here that needs an app of your own. It takes a couple of minutes, once.

## Why there is no shared client for this one

Google and Slack authorise against a client Lanes operates, so there is no console to visit.
Reddit cannot work that way, and the reason is how it meters access: **Reddit's rate limit is a
hundred queries a minute per OAuth client id** — not per user and not per token.

A client everyone shared would pool every install of this program into one bucket. Your limit
would be reached by strangers, and the failure would arrive as somebody else's traffic. An app of
your own gets its own hundred, which is the whole budget for one person and nowhere near it for
the next.

## Registering the app

1. Open <https://www.reddit.com/prefs/apps> and choose **create another app...**.
2. Give it a name you will recognise later. The name is how you revoke this one without touching
   your other apps.
3. Choose **web app**. The other two do not fit: `script` only ever reaches your own account, and
   `installed app` issues no secret for this to hold.
4. Set the redirect uri to exactly:

   ```
   http://127.0.0.1:8765/callback
   ```

   Reddit matches this character for character. It is the address `connect` listens on, and a
   different port or `localhost` in place of `127.0.0.1` will be refused after you approve the
   consent screen rather than before.
5. Create the app. The **client id** is the string just under the app name; the **secret** is the
   field labelled `secret`.

Then run the connect command above. You will be asked for both values once, they are stored in
your credential store, and the browser opens.

## Registering for API access

Creating an app is not the same as being allowed to call the API. Reddit's
[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
says access must be requested and approved, and the create-app page links to that separately.

The quickest way to find out where you stand is to ask for an app-only token:

```console
$ curl -sS -X POST -u "<client_id>:<client_secret>" \
    -A "lanes-link/0.3" \
    -d "grant_type=client_credentials" \
    -w "\nHTTP %{http_code}\n" \
    https://www.reddit.com/api/v1/access_token
```

`200` means the gate is open. `403`, or an HTML page instead of JSON, means the app exists but
access has not been granted yet.

## What you get

Reads are granted by default. Writing needs the write bundle, and the three scopes that post,
edit, and vote are marked broad on the consent screen because they act publicly under your
username — a post is visible to everyone who reads the subreddit, and deleting it later leaves the
deletion behind.

Two things are worth knowing before an agent posts anywhere:

- **Most subreddits require a flair.** `reddit.list_flairs` returns the templates and their ids;
  pass one as `flair_id`. A submission without one is rejected by the subreddit, not by the API.
- **`reddit.get_rules` is cheap and worth reading first.** Most removals are rule violations rather
  than API errors, and the API will not tell you that.

## When it stops working

| What you see | What it is |
|---|---|
| `invalid redirect_uri` in the browser | The app's redirect uri is not exactly `http://127.0.0.1:8765/callback` |
| Connected, then every call fails an hour later | The grant was made without `duration=permanent`. Reconnect with `--replace` |
| `403` or HTML from every call | The app exists but API access has not been approved |
| `429` | The hundred-per-minute limit for this client id. It is per client, so nothing else is spending it |
| `Port 8765 is already in use` | Something else holds the port. The redirect names it exactly, so it cannot be moved — free the port |

If you regenerate the secret, run:

```console
$ lanes link connect reddit --profile personal --target local --replace
```
