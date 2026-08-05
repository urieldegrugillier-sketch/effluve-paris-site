# Graph Report - .  (2026-08-05)

## Corpus Check
- 25 files · ~277,699 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 447 nodes · 539 edges · 97 communities (45 shown, 52 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.62)
- Token cost: 229,123 input · 0 output

## Community Hubs (Navigation)
- Scroll Canvas Animation Engine
- Shopping Cart & Promo Logic
- Account/Session Management (Supabase)
- Order Confirmation Email
- Production Build Pipeline
- Site Pages & Design Principles
- Admin Order Dashboard
- Cart Preview Widget
- Email Popup & Field Validation
- NPM Package Config
- Note-Highlight Annotation Widget
- Shipping Notification Email
- Wrangler Dev No-op Worker (A)
- Wrangler Dev No-op Worker (B)
- Mobile Nav Menu
- i18n Translation Engine
- Phone Number Input Widget
- Design Skills & Guidelines
- Effluve Brand Wordmarks/Logos
- Check-Email-Exists Edge Function
- Wrangler Middleware Loader (A)
- Wrangler Middleware Loader (B)
- Hero Scroll Mechanics & Sections
- Google Places Autocomplete
- Check-Email-Exists Function Config
- Create-Checkout-Session Function Config
- Stripe-Webhook Function Config
- Mark-Order-Shipped Function Config
- Validate-Promo-Code Function Config
- Admin Auth & Security Rationale
- Contact Page Styling
- Cookie Consent Banner
- Create-Checkout-Session Function
- Admin RLS Recursion Fix Migration
- Account Profile & Address Sections
- Admin Shipping Modal Flow
- Hero Frame 0001 (Bottle + Brand)
- Favicon Assets
- Paris Wordmark Asset
- Product Bottle Reference Shots
- Legal & Privacy Pages
- WhatsApp Support Deep Links
- Newsletter Signup Capture
- Live Stock Progress Bar
- Validate-Promo-Code Function
- Promo Codes Table Migration
- Newsletter Subscribers Migration
- Wrangler Middleware Facade (A)
- Wrangler Middleware Facade (B)
- 404 Page
- Frame-Scroll Binding Mechanism
- Canvas Cover-Mode Renderer
- Section Animation Choreography
- Account Deletion Flow
- Account Order History
- Hero Frame 0030 (Shatter)
- Hero Frame 0060 (Shatter)
- Hero Frame 0090 (Shatter)
- Hero Frame 0120 (Shatter)
- Apple Touch Icon
- Email Product Thumbnail
- Checkout Accordion Flow
- Checkout Promo Code Form
- Checkout Trust Badges
- Checkout WhatsApp Support
- Honeypot Spam Protection
- Sitewide Base Styles
- Source Video Transcript
- Places Autocomplete Module
- Orders Table (Schema)
- Profiles Table (Schema)
- Graphify Graph Notes
- Project Overview & Structure
- Stripe-Webhook Edge Function
- Validate-Promo-Code Edge Function
- Orders Table (Ref)
- Orders Table (Ref)
- Profiles Table (Ref)
- Orders Table (Ref)

## God Nodes (most connected - your core abstractions)
1. `client()` - 11 edges
2. `mountAccountGate()` - 11 edges
3. `readCart()` - 10 edges
4. `addToCart()` - 8 edges
5. `Product Page` - 8 edges
6. `renderOrders()` - 8 edges
7. `render()` - 7 edges
8. `bind()` - 7 edges
9. `main()` - 7 edges
10. `buildConfirmationEmail()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Custom Reason Dropdown (Listbox Pattern)` --calls--> `t()`  [AMBIGUOUS]
  contact.html → js/i18n.js
- `Product Page Payment Request Button (Express Buy)` --calls--> `recordOrder()`  [EXTRACTED]
  product.html → js/account.js
- `Product Page` --calls--> `flashPreview()`  [EXTRACTED]
  product.html → js/cart-widget.js
- `Product Page` --calls--> `addToCart()`  [EXTRACTED]
  product.html → js/cart.js
- `Sticky Mobile Buy Bar` --calls--> `addToCart()`  [EXTRACTED]
  product.html → js/cart.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Account Page Logged-In Sections** — account_edit_profile, account_saved_address, account_order_history, account_delete_account [EXTRACTED 1.00]
- **Checkout Order Summary Column Widgets** — checkout_promo_code, checkout_trust_badges, checkout_whatsapp_support [EXTRACTED 1.00]
- **Video-to-Website Skill's Core Animation Mechanisms** — _claude_skills_video_to_website_skill_lenissmoothscroll, _claude_skills_video_to_website_skill_circlewipeheroreveal, _claude_skills_video_to_website_skill_paddedcovermode, _claude_skills_video_to_website_skill_frametoscrollbinding, _claude_skills_video_to_website_skill_sectionanimationsystem, index_html_scrolldrivenexperience [INFERRED 0.85]

## Communities (97 total, 52 thin omitted)

### Community 0 - "Scroll Canvas Animation Engine"
Cohesion: 0.06
Nodes (36): canvas, canvasWrap, containerScrollRange(), ctaSection, ctaSpacer, ctx, darkOverlay, drawFrame() (+28 more)

### Community 1 - "Shopping Cart & Promo Logic"
Cohesion: 0.15
Nodes (26): addToCart(), applyPromoCode(), clearCart(), dispatchStockClamp(), getAppliedPromoCode(), getCart(), getCartCount(), getCartTotal() (+18 more)

### Community 2 - "Account/Session Management (Supabase)"
Cohesion: 0.18
Nodes (23): accountGateMarkup(), checkEmailExists(), client(), continueAsGuest(), createAccount(), deleteAccount(), findAccount(), getOrders() (+15 more)

### Community 3 - "Order Confirmation Email"
Cohesion: 0.15
Nodes (22): RFC-6068, buildConfirmationEmail(), computePriceBreakdown(), ConfirmationEmailDetails, countryLabel(), escapeHtml(), extractFirstName(), formatMoney() (+14 more)

### Community 4 - "Production Build Pipeline"
Cohesion: 0.14
Nodes (20): ASSETS_DIR, buildCss(), buildJs(), CleanCSS, copyAssets(), copyHtml(), copyRootFiles(), CSS_DIR (+12 more)

### Community 5 - "Site Pages & Design Principles"
Cohesion: 0.16
Nodes (13): Avoid Generic AI Aesthetics Principle, CGV Terms of Sale Page, FAQ Page, GSAP Animation Library, Home Page (Scroll Experience), Acquisition CTA (Persist/Unpin), formatCountdown(), formatCountdownHTML() (+5 more)

### Community 6 - "Admin Order Dashboard"
Cohesion: 0.28
Nodes (14): checkAccessAndInit(), client(), customerLabel(), escapeHtml(), formatDate(), formatMoney(), initLogout(), initOrders() (+6 more)

### Community 7 - "Cart Preview Widget"
Cohesion: 0.20
Nodes (12): closePreview(), closePreviewAndReturnFocus(), flashPreview(), focusFirstPreviewElement(), getFocusablePreviewElements(), money(), openPreview(), positionPreview() (+4 more)

### Community 8 - "Email Popup & Field Validation"
Cohesion: 0.24
Nodes (12): RFC-5322, captureEmail(), cookieBannerStillUp(), isValidAddressFormat(), isValidCardNameFormat(), isValidCityFormat(), isValidEmailFormat(), isValidNameFormat() (+4 more)

### Community 9 - "NPM Package Config"
Cohesion: 0.17
Nodes (11): clean-css, description, devDependencies, clean-css, terser, name, private, scripts (+3 more)

### Community 10 - "Note-Highlight Annotation Widget"
Cohesion: 0.45
Nodes (11): bind(), clearAll(), onBlur(), onClick(), onEnter(), onFocus(), onLeave(), render() (+3 more)

### Community 11 - "Shipping Notification Email"
Cohesion: 0.21
Nodes (10): buildShippingEmail(), CORS_HEADERS, escapeHtml(), OrderRow, RESEND_API_KEY, resolveCustomerEmailAndName(), sendShippingEmail(), ShippingEmailDetails (+2 more)

### Community 12 - "Wrangler Dev No-op Worker (A)"
Cohesion: 0.31
Nodes (6): __facade_invoke__(), __facade_invokeChain__(), __facade_register__(), fetch(), wrapExportedHandler(), wrapWorkerEntrypoint()

### Community 13 - "Wrangler Dev No-op Worker (B)"
Cohesion: 0.31
Nodes (6): __facade_invoke__(), __facade_invokeChain__(), __facade_register__(), fetch(), wrapExportedHandler(), wrapWorkerEntrypoint()

### Community 14 - "Mobile Nav Menu"
Cohesion: 0.31
Nodes (6): closeMenu(), getFocusableMenuElements(), openMenu(), resetInfoAccordion(), sizeMenuHeight(), trapTab()

### Community 15 - "i18n Translation Engine"
Cohesion: 0.52
Nodes (6): Custom Reason Dropdown (Listbox Pattern), apply(), getLang(), resolveKey(), setLang(), t()

### Community 16 - "Phone Number Input Widget"
Cohesion: 0.48
Nodes (5): countryName(), lang(), mount(), normalizeNumber(), t()

### Community 17 - "Design Skills & Guidelines"
Cohesion: 0.33
Nodes (6): Frontend Design Skill, Bold Aesthetic Direction Principle, Scroll-Driven Website Design Guidelines, Video to Website Skill, Scroll-Driven Canvas Experience, Carousel + Lightbox Viewer

### Community 18 - "Effluve Brand Wordmarks/Logos"
Cohesion: 0.33
Nodes (6): Effluve Logo (Dark Background Variant), Effluve Logo (Light Background), Effluve Wordmark (Dark Background), Effluve Word Dark Bg, Paris Word Dark Bg, Effluve (Brand)

### Community 19 - "Check-Email-Exists Edge Function"
Cohesion: 0.40
Nodes (5): emailExists(), listUsersPage(), RequestBody, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

### Community 22 - "Hero Scroll Mechanics & Sections"
Cohesion: 0.40
Nodes (5): Circle-Wipe Hero Reveal Mechanism, Lenis Smooth Scroll Mechanism, Premium Checklist (Non-Negotiable), Composition Pyramid Section (Pinned), Stats Section (Counters)

### Community 24 - "Check-Email-Exists Function Config"
Cohesion: 0.40
Nodes (4): imports, @supabase/functions-js, @supabase/server, @supabase/supabase-js

### Community 25 - "Create-Checkout-Session Function Config"
Cohesion: 0.40
Nodes (4): imports, stripe, @supabase/functions-js, @supabase/server

### Community 26 - "Stripe-Webhook Function Config"
Cohesion: 0.40
Nodes (4): imports, stripe, @supabase/functions-js, @supabase/supabase-js

### Community 27 - "Mark-Order-Shipped Function Config"
Cohesion: 0.50
Nodes (3): imports, @supabase/functions-js, @supabase/supabase-js

### Community 28 - "Validate-Promo-Code Function Config"
Cohesion: 0.50
Nodes (3): imports, @supabase/functions-js, @supabase/server

### Community 29 - "Admin Auth & Security Rationale"
Cohesion: 0.67
Nodes (3): Post-Login Redirect to Admin (server-verified), Admin Auth Gate (client UX + server RLS), Security Headers & CSP Rationale

## Ambiguous Edges - Review These
- `Custom Reason Dropdown (Listbox Pattern)` → `t()`  [AMBIGUOUS]
  contact.html · relation: calls

## Knowledge Gaps
- **130 isolated node(s):** `__INTERNAL_WRANGLER_MIDDLEWARE__`, `__INTERNAL_WRANGLER_MIDDLEWARE__`, `canvas`, `ctx`, `canvasWrap` (+125 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **52 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Custom Reason Dropdown (Listbox Pattern)` and `t()`?**
  _Edge tagged AMBIGUOUS (relation: calls) - confidence is low._
- **Why does `addToCart()` connect `Shopping Cart & Promo Logic` to `Site Pages & Design Principles`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `Product Page` connect `Site Pages & Design Principles` to `Shopping Cart & Promo Logic`, `Cart Preview Widget`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Why does `Product Page Payment Request Button (Express Buy)` connect `Shopping Cart & Promo Logic` to `Account/Session Management (Supabase)`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `__INTERNAL_WRANGLER_MIDDLEWARE__`, `__INTERNAL_WRANGLER_MIDDLEWARE__`, `canvas` to the rest of the system?**
  _130 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Scroll Canvas Animation Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.057004830917874394 - nodes in this community are weakly interconnected._
- **Should `Order Confirmation Email` be split into smaller, more focused modules?**
  _Cohesion score 0.14624505928853754 - nodes in this community are weakly interconnected._