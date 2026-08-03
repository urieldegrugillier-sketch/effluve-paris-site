# Graph Report - c:\Users\uriel\Documents\Projects\Parfum_MONARK\Parfum_Code  (2026-08-03)

## Corpus Check
- 185 files · ~259,912 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 390 nodes · 524 edges · 56 communities (34 shown, 22 thin omitted)
- Extraction: 92% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.61)
- Token cost: 501,033 input · 0 output

## Community Hubs (Navigation)
- Scroll-Driven Hero Canvas
- Account & Order Management
- Site Pages & Legal/SEO
- Cart & Promo Pricing
- Static Build Script
- Cart Preview Widget
- Email Capture Popup
- Address & Phone Input
- Build Dependencies
- Text Highlight Widget
- Wrangler Dev Artifact (1RMrYZ)
- Wrangler Dev Artifact (QTIsxw)
- Stripe Payment Flow
- Navigation Menu
- Promo Countdown Timer
- Stripe Webhook Handler
- Design & Animation Skills
- Internationalization (i18n)
- Check-Email-Exists Function
- Wrangler Bundle Loader (ENakUB)
- Wrangler Bundle Loader (mIwJ5Q)
- Hero Reveal & Composition Sections
- Effluve Brand Identity Assets
- Google Places Autocomplete
- Check-Email Function Config
- Checkout Session Function Config
- Stripe Webhook Function Config
- Promo Code Function Config
- Cookie Consent Banner
- Create-Checkout-Session Function
- Favicon Assets
- Product Photography Assets
- Newsletter Signup
- Stock Level Display
- Validate-Promo-Code Function
- DB Migration: Promo Codes
- DB Migration: Newsletter Table
- Wrangler Bundle Facade (ENakUB)
- Wrangler Bundle Facade (mIwJ5Q)
- Frame-to-Scroll Binding Technique
- Padded Cover Mode Technique
- Section Animation System Technique
- Apple Touch Icon Asset
- Video Transcript
- Orders DB Table
- Profiles DB Table
- Supabase Platform

## God Nodes (most connected - your core abstractions)
1. `MONARK Project README` - 14 edges
2. `mountAccountGate()` - 13 edges
3. `client()` - 11 edges
4. `readCart()` - 10 edges
5. `Product Page` - 10 edges
6. `Checkout Page` - 9 edges
7. `updateAccount()` - 8 edges
8. `addToCart()` - 8 edges
9. `render()` - 7 edges
10. `bind()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Custom Reason Dropdown (Listbox Pattern)` --calls--> `t()`  [AMBIGUOUS]
  contact.html → js/i18n.js
- `renderSummary() Shared Summary Rendering` --calls--> `subscribe()`  [EXTRACTED]
  checkout.html → js/promo-countdown.js
- `Edit Profile Form` --calls--> `MonarkValidateName()`  [EXTRACTED]
  account.html → js/email-popup.js
- `Saved Shipping Address Form` --calls--> `updateAccount()`  [EXTRACTED]
  account.html → js/account.js
- `Saved Card (Mocked) Form` --calls--> `updateAccount()`  [EXTRACTED]
  account.html → js/account.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shared Footer Navigation Across All Pages** — 404_html, account_html, cgv_html, checkout_html, confidentialite_html, contact_html, faq_html, index_html, mentions_legales_html, product_html [EXTRACTED 1.00]
- **End-to-End Checkout & Payment Flow** — account_html_accountgate, checkout_html_accordionstatemachine, checkout_html_stripeelementspayment, checkout_html_paymentrequestbutton, product_html_paymentrequestbutton, supabase_functions_create_checkout_session, supabase_functions_stripe_webhook, stripe [INFERRED 0.85]
- **Video-to-Website Skill's Core Animation Mechanisms** — _claude_skills_video_to_website_skill_lenissmoothscroll, _claude_skills_video_to_website_skill_circlewipeheroreveal, _claude_skills_video_to_website_skill_paddedcovermode, _claude_skills_video_to_website_skill_frametoscrollbinding, _claude_skills_video_to_website_skill_sectionanimationsystem, index_html_scrolldrivenexperience [INFERRED 0.85]

## Communities (56 total, 22 thin omitted)

### Community 0 - "Scroll-Driven Hero Canvas"
Cohesion: 0.06
Nodes (36): canvas, canvasWrap, containerScrollRange(), ctaSection, ctaSpacer, ctx, darkOverlay, drawFrame() (+28 more)

### Community 1 - "Account & Order Management"
Cohesion: 0.11
Nodes (33): Account Gate (Login/Create/Guest), Delete Account Flow, Edit Profile Form, Order History Section, Saved Card (Mocked) Form, Checkout Account Step, completeOrder() Shared Order Completion, renderSummary() Shared Summary Rendering (+25 more)

### Community 2 - "Site Pages & Legal/SEO"
Cohesion: 0.11
Nodes (24): 404 Not Found Page, Avoid Generic AI Aesthetics Principle, Account Page, CGV Terms of Sale Page, Checkout Page, pollForOrderReference(), Privacy Policy Page, Contact Page (+16 more)

### Community 3 - "Cart & Promo Pricing"
Cohesion: 0.16
Nodes (25): Promo Code Apply Flow, addToCart(), applyPromoCode(), clearCart(), dispatchStockClamp(), getAppliedPromoCode(), getCart(), getCartCount() (+17 more)

### Community 4 - "Static Build Script"
Cohesion: 0.14
Nodes (20): ASSETS_DIR, buildCss(), buildJs(), CleanCSS, copyAssets(), copyHtml(), copyRootFiles(), CSS_DIR (+12 more)

### Community 5 - "Cart Preview Widget"
Cohesion: 0.18
Nodes (13): closePreview(), closePreviewAndReturnFocus(), flashPreview(), focusFirstPreviewElement(), getFocusablePreviewElements(), money(), openPreview(), positionPreview() (+5 more)

### Community 6 - "Email Capture Popup"
Cohesion: 0.24
Nodes (12): RFC-5322, captureEmail(), cookieBannerStillUp(), isValidAddressFormat(), isValidCardNameFormat(), isValidCityFormat(), isValidEmailFormat(), isValidNameFormat() (+4 more)

### Community 7 - "Address & Phone Input"
Cohesion: 0.23
Nodes (11): Saved Shipping Address Form, Checkout Accordion State Machine, Shipping Form Validation, Google Places Autocomplete Integration, MonarkValidateName(), countryName(), lang(), mount() (+3 more)

### Community 8 - "Build Dependencies"
Cohesion: 0.17
Nodes (11): clean-css, description, devDependencies, clean-css, terser, name, private, scripts (+3 more)

### Community 9 - "Text Highlight Widget"
Cohesion: 0.45
Nodes (11): bind(), clearAll(), onBlur(), onClick(), onEnter(), onFocus(), onLeave(), render() (+3 more)

### Community 10 - "Wrangler Dev Artifact (1RMrYZ)"
Cohesion: 0.31
Nodes (6): __facade_invoke__(), __facade_invokeChain__(), __facade_register__(), fetch(), wrapExportedHandler(), wrapWorkerEntrypoint()

### Community 11 - "Wrangler Dev Artifact (QTIsxw)"
Cohesion: 0.31
Nodes (6): __facade_invoke__(), __facade_invokeChain__(), __facade_register__(), fetch(), wrapExportedHandler(), wrapWorkerEntrypoint()

### Community 12 - "Stripe Payment Flow"
Cohesion: 0.31
Nodes (9): Checkout Payment Request Button (Apple/Google Pay/Link), Stripe Elements Payment (Card), css/style.css Sitewide Styles, window.MonarkStripe Client, Product Page Payment Request Button (Express Buy), Production Build (Minification), Project Structure Overview, Stripe Payment Platform (+1 more)

### Community 13 - "Navigation Menu"
Cohesion: 0.31
Nodes (6): closeMenu(), getFocusableMenuElements(), openMenu(), resetInfoAccordion(), sizeMenuHeight(), trapTab()

### Community 14 - "Promo Countdown Timer"
Cohesion: 0.43
Nodes (5): formatCountdown(), formatCountdownHTML(), getRemainingSeconds(), subscribe(), unitsFromSeconds()

### Community 15 - "Stripe Webhook Handler"
Cohesion: 0.33
Nodes (6): generateReferenceNumber(), reconcileOrder(), STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

### Community 16 - "Design & Animation Skills"
Cohesion: 0.33
Nodes (6): Frontend Design Skill, Bold Aesthetic Direction Principle, Scroll-Driven Website Design Guidelines, Video to Website Skill, Scroll-Driven Canvas Experience, Carousel + Lightbox Viewer

### Community 17 - "Internationalization (i18n)"
Cohesion: 0.67
Nodes (5): apply(), getLang(), resolveKey(), setLang(), t()

### Community 18 - "Check-Email-Exists Function"
Cohesion: 0.40
Nodes (5): emailExists(), listUsersPage(), RequestBody, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

### Community 21 - "Hero Reveal & Composition Sections"
Cohesion: 0.40
Nodes (5): Circle-Wipe Hero Reveal Mechanism, Lenis Smooth Scroll Mechanism, Premium Checklist (Non-Negotiable), Composition Pyramid Section (Pinned), Stats Section (Counters)

### Community 22 - "Effluve Brand Identity Assets"
Cohesion: 0.40
Nodes (5): Effluve Logo (Dark Background Variant), Effluve Logo (Light Background), Effluve Word Dark Bg, Paris Word Dark Bg, Effluve (Paris) Brand

### Community 24 - "Check-Email Function Config"
Cohesion: 0.40
Nodes (4): imports, @supabase/functions-js, @supabase/server, @supabase/supabase-js

### Community 25 - "Checkout Session Function Config"
Cohesion: 0.40
Nodes (4): imports, stripe, @supabase/functions-js, @supabase/server

### Community 26 - "Stripe Webhook Function Config"
Cohesion: 0.40
Nodes (4): imports, stripe, @supabase/functions-js, @supabase/supabase-js

### Community 27 - "Promo Code Function Config"
Cohesion: 0.50
Nodes (3): imports, @supabase/functions-js, @supabase/server

## Ambiguous Edges - Review These
- `t()` → `Custom Reason Dropdown (Listbox Pattern)`  [AMBIGUOUS]
  contact.html · relation: calls

## Knowledge Gaps
- **98 isolated node(s):** `__INTERNAL_WRANGLER_MIDDLEWARE__`, `__INTERNAL_WRANGLER_MIDDLEWARE__`, `canvas`, `ctx`, `canvasWrap` (+93 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `t()` and `Custom Reason Dropdown (Listbox Pattern)`?**
  _Edge tagged AMBIGUOUS (relation: calls) - confidence is low._
- **Why does `Product Page` connect `Site Pages & Legal/SEO` to `Cart & Promo Pricing`, `Cart Preview Widget`, `Promo Countdown Timer`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `addToCart()` connect `Cart & Promo Pricing` to `Site Pages & Legal/SEO`, `Stripe Payment Flow`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Why does `Product Page Payment Request Button (Express Buy)` connect `Stripe Payment Flow` to `Account & Order Management`, `Cart & Promo Pricing`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **What connects `__INTERNAL_WRANGLER_MIDDLEWARE__`, `__INTERNAL_WRANGLER_MIDDLEWARE__`, `canvas` to the rest of the system?**
  _98 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Scroll-Driven Hero Canvas` be split into smaller, more focused modules?**
  _Cohesion score 0.057004830917874394 - nodes in this community are weakly interconnected._
- **Should `Account & Order Management` be split into smaller, more focused modules?**
  _Cohesion score 0.10960960960960961 - nodes in this community are weakly interconnected._