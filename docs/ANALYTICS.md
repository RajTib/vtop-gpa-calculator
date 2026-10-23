# Cloudflare Web Analytics: setup

**Status: not enabled.** The repository contains no analytics script, token or snippet, and no
Cloudflare configuration, so none was added. The site is hosted on Vercel; nothing about hosting
needs to change to use Cloudflare Web Analytics.

Cloudflare Web Analytics is cookie-less and does not fingerprint visitors. It measures page views,
referrers, countries, browsers and Core Web Vitals. The app never sends grades, courses or any
profile data anywhere, and this setup doesn't change that.

## What you need to do

1. In the Cloudflare dashboard open **Analytics & Logs -> Web Analytics -> Add a site**
   (a free Cloudflare account is enough; the domain does **not** have to use Cloudflare DNS).
2. Enter the site's hostname (your production domain, or the `*.vercel.app` hostname if that is
   the public URL) and choose the manual / JS snippet option. If Cloudflare rejects a
   `*.vercel.app` hostname, a custom domain is needed; I could not verify this restriction from here.
3. Cloudflare shows a snippet like this (the token is specific to your site):

   ```html
   <script defer src="https://static.cloudflareinsights.com/beacon.min.js"
           data-cf-beacon='{"token": "<YOUR_SITE_TOKEN>"}'></script>
   ```

4. Send me the snippet (or paste it yourself) and it goes in `index.html` just before the
   `<script src="js/parser.js">` line (or immediately before `</body>`). It is a single,
   self-contained edit. The beacon token is public by design (it appears in page source), so it is
   not a secret, but it still comes from your dashboard and must not be invented.
5. Deploy through your normal Vercel flow and confirm in the Web Analytics dashboard after a few
   minutes of traffic.

## Notes

- No Content-Security-Policy is configured today, so the beacon needs no extra headers. If a CSP is
  added later, allow `https://static.cloudflareinsights.com` (script) and
  `https://cloudflareinsights.com` (beacon requests).
- Do not add a second analytics tool, session recording or event tracking of grades. That is out of
  scope and would conflict with the "grades never leave the browser" property.
