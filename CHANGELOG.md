# Changelog

## 0.4.0

Tested end to end against real apps (WooCommerce storefront, WordPress admin, a Next.js SaaS panel) and a cold-start run by a fresh Claude session.

**Safety**
- Mapping is read-only: the crawler never presses a button that submits a form, nor cart/buy/order, publish, invite or delete-like buttons, and never follows links that act on a GET (delete, trash, add-to-cart, reorder, logout). Previously "Add to cart" could be pressed while mapping.
- Secrets stay out of `config.yaml`: use `${DEMO_PASSWORD}` and put the value in `.demo-video/.env` (git-ignored, added to existing `.gitignore` files too).

**Targeting**
- Only visible elements are matched (hidden sign-up tabs, mobile menus are skipped).
- An element whose name matches exactly wins over substring matches ("Publish" button vs. a "Publish" panel toggle).
- Exact labels ignore required markers (`Password *`).
- Custom-styled radios/checkboxes are clicked through their label.
- `select` options match whitespace-insensitively (`&nbsp;` in prices) or by a unique part of the label (`option: Vinyl`).
- Typing clicks a spot that really is the field (not a spinner or "show password" eye) and makes sure the field has focus.

**Login**
- New `authCheck` setting: check the session on a page that needs login (for apps with a public home page such as WordPress); without a cached session the login always runs.
- After submitting the login form, wait until the sign-in page is really gone before checking the session.

**Mapping**
- Query strings are kept where they are the route (`edit.php?post_type=...`, explicit `--only` / `crawl.start` URLs); tracking/nonce parameters are dropped.
- Radios/checkboxes show their group (`radio "Yes" in radiogroup "Lamination"`).
- Fields that share a name on one page are flagged (use `within`).
- Buttons in an `<aside>` are no longer dropped; repeated buttons are listed once under the global menu.

**Video**
- Things in the caption band at the bottom are scrolled up before they're used or zoomed on.
- When the cursor heads outside the zoomed view (to the next button), the camera zooms out with it instead of leaving the button off-screen.
- Optional setup/teardown steps no longer wait 30 s for elements that don't exist.

## 0.3.1

- README with a demo GIF and video made by walkreel from the bundled example app.

## 0.3.0

- First npm release: `npx walkreel install`, look-alike lists for native `<select>`, colors from the app, quiet opt-in guitar music, landscape/vertical/square formats, setup/teardown, `displayUrl`, `hide`, `doctor`.
