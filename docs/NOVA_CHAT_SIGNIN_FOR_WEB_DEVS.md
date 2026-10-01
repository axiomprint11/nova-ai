# Nova chat on axiomprint.com: sign-in, dictation and message box (update for website developers)

**From:** Nova team · **Date:** October 1, 2026 · **Nova version:** 1.6.4

## In short

Customers can now **sign in from inside the Nova chat**, and doing so signs them in on the website too. **This already
works with the header script you have now; nothing has to change.** Two small, optional hooks make it smoother; they
are described below.

This release also adds speech-to-text in the chat and a one-line message box. Neither needs anything from the website,
except possibly one header (see "Dictation").

## What the customer sees

A guest sees a **Sign in** button in the chat's top bar, next to the close button. (Signed-in customers see
**History** there instead.)

After signing in, the chat greets them by first name ("Hi Gus!"), shows "Signed in as Gus Kim", and keeps the
conversation that was on screen. Account pricing, **My projects** and **Add to Cart** switch on straight away.

## How it works now, without any website changes

1. Clicking **Sign in** opens the website's own login page, `https://axiomprint.com/login`, in a small window.
2. The customer logs in there as usual. The website saves the login in `localStorage['axiom-print-app']`, as it does
   today.
3. Nova's header script notices the new login and signs the chat in. It watches with the browser's `storage` event,
   and checks every 2.5 s while the chat is open. It then closes the login window.

The header script now also **follows logins and logouts done anywhere on the site**, in this tab or another tab,
without a page refresh. Before this update, the chat only picked up a login when the page loaded.

**One thing to note:** the page the customer is on was loaded before the login, so its own header still says
"Sign in" until it refreshes. Hook 2 below fixes that.

## Optional hooks

Add these to the `window.NovaClientChat` object you already have in the site header:

```html
<script>
  window.NovaClientChat = Object.assign(window.NovaClientChat || {}, {
    testKey: 'PASTE_CLIENT_BOT_TEST_KEY',   // unchanged: keep it while Nova is in Test mode
    tokenKey: 'axiom-print-app',            // unchanged

    // 1) OPTIONAL: email and password form inside the chat (no login window).
    //    Use the site's normal login code, so the site's header, store and cart update too.
    login: async (email, password) => {
      const r = await siteLogin(email, password);   // your existing login request + saving the token
      return r.token;                               // on failure: throw new Error('Wrong email or password')
    },

    // 2) OPTIONAL: runs after a customer signs in through the chat's login window.
    //    Refresh the page's own logged-in state (header name, cart count).
    onSignedIn: () => { /* e.g. reload the user store, or location.reload() */ },

    // 3) OPTIONAL: a different login page (must be on axiomprint.com). This is the default:
    loginUrl: 'https://axiomprint.com/login',
  });
</script>
<script src="https://nova.axiomprint.com/client-embed.js" defer></script>
```

### Hook 1: `login(email, password)`

If you provide this function, **Sign in** shows an email and password form inside the chat instead of opening the
login window.

- **What it receives:** the email and password the customer typed.
- **What it must do:** log the customer in exactly as the website's own login form does. Call the login API, save the
  token in `axiom-print-app`, and update the header and cart.
- **What it returns:** the customer token, either as a string or as `{ token }` / `{ access_token }`. It may return a
  Promise.
- **On failure:** throw an error, or reject, with a short message the customer can read, such as "Wrong email or
  password". The chat shows that message under the form.

Security:

- The chat posts the email and password **only to the website page** that embeds it, using `postMessage` locked to
  `https://axiomprint.com` / `https://www.axiomprint.com`.
- They never go to Nova's server, are never stored, and the AI never sees them.
- The AI is also told never to ask for a password in the conversation.

### Hook 2: `onSignedIn()`

Called after a sign-in through the chat's login window, once the chat has picked up the new token. Use it to refresh
the page's own logged-in state.

### Telling the chat about the site's own login or logout (optional)

When the website logs a customer in or out through its own forms, you can tell the chat right away:

```js
window.NovaClientChatAPI && window.NovaClientChatAPI.loginChanged();
```

If you don't call it, the chat still notices within about 2.5 seconds.

## Dictation (speech to text)

- The chat has a microphone button next to Send. Tapping it shows a recording bar (timer, live waveform, Cancel,
  Done); on Done the words appear in the message box. The first time it is used, the browser asks the customer for
  microphone permission.
- The header script already loads the chat frame with `allow="microphone"`.
- **Check:** if the website sends a `Permissions-Policy` HTTP header, it must allow the microphone for Nova:

  ```
  Permissions-Policy: microphone=(self "https://nova.axiomprint.com")
  ```

  If the site sends no `Permissions-Policy` header, nothing is needed.

## Message box

The message box is one line now. It no longer shows a scrollbar, and the hint is shorter on phones. Nothing is needed
from the website.

## Pop-up blockers

The chat opens the login window itself, inside the customer's click, so pop-up blockers (including Safari's) allow it.
If a browser still refuses, the header script tries again from the page. If that is also refused, it goes to the
login page in the same tab. Your login page should therefore send the customer back where they came from after a
login, if it doesn't already.

## How to test

1. Open any page with `?nova=test` (Nova is in Test mode).
2. While logged out, open the chat and click **Sign in**.
   - **Without the `login` hook:** log in in the window that opens. The window should close by itself, and the chat
     should say "Hi <first name>!" and "Signed in as …".
   - **With the `login` hook:** try a wrong password first; the form should show your error message. Then use the
     right one; the chat signs in and the site's header should update.
3. Log out on the website. Within a few seconds, the chat goes back to guest.
4. Log in on the website in another tab. The chat on the first tab signs in by itself.
5. On a phone or in Chrome, tap the microphone, allow access, speak, and check that the words appear in the box.

## Messages between the page and the chat (reference)

All messages go through `postMessage` and are origin-checked on both sides. The header script already handles them.

| From → to | `type` | Data |
|---|---|---|
| chat → page | `nova-client:open-login` | `opened` (true if the chat opened the window itself) |
| page → chat | `nova-client:login-ready` | — (sent only when `login` is defined) |
| chat → page | `nova-client:login` | `id`, `email`, `password` |
| page → chat | `nova-client:login-result` | `id`, `ok`, `error` |
| page → chat | `nova-client:login-url` | `url` (sent only when `loginUrl` is set) |
| page → chat | `nova-client:signin` / `nova-client:signout` | `customer_token` (verified by Nova with `GET laravelapi …/api/v1/customers/me`) |

Questions: ask the Nova team.
