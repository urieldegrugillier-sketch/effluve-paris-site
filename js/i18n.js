/* MONARK — bilingual FR/EN infrastructure.
   Phase 1: engine + full index.html translation. Other pages don't carry
   data-i18n attributes yet, so apply() is a no-op on them until they're
   rolled in — safe to include there early once that happens.

   Pattern: every translatable element carries data-i18n="namespaced.key"
   (textContent swap) or data-i18n-html="namespaced.key" (innerHTML swap,
   only for our own authored strings with markup like <br> — never for
   anything derived from user input). data-i18n-attr="attr:key;attr2:key2"
   covers attributes (aria-label, placeholder, etc). TRANSLATIONS is the
   single source of truth both index.html and the shared widget scripts
   (nav-menu.js, cookie-consent.js, email-popup.js, promo-banner.js,
   cart-widget.js) read from — those inject their own markup at runtime, so
   each calls MonarkI18n.apply() on its own container after building it,
   rather than relying on a single DOMContentLoaded pass over static HTML. */
(function () {
  const STORAGE_KEY = 'monark_lang';
  const DEFAULT_LANG = 'fr';

  const TRANSLATIONS = {
    en: {
      a11y: {
        skipToContent: 'Skip to content',
        previousImage: 'Previous image',
        nextImage: 'Next image'
      },
      nav: {
        experience: 'The Experience',
        acquire: 'Acquire'
      },
      hero: {
        label: 'Eau de Parfum',
        tagline: 'A scent built for men who rule rooms without entering them.',
        subtext: 'Click to discover',
        scroll: 'Scroll to Begin the Reign'
      },
      // Static trust/value section right after the hero (index.html) -- see
      // that page's own comment on why this sits outside the scroll-jacked
      // #scroll-container system (s1-s6 above/below). trustReturns/"14 days"
      // deliberately matches product.html's own stated return policy
      // (product.returnPolicy, 14 days) and checkout's trust badges, not a
      // separate, differently-worded claim.
      home: {
        whyEffluve: {
          // EN stays one line at every width (per explicit instruction) --
          // unlike the FR heading below, no .mobile-only-break here. Space
          // before "?" is intentional (also per explicit instruction), not
          // standard English typography. Still rendered via data-i18n-html
          // (see index.html) for consistency with the FR string, even
          // though this one has no markup of its own to preserve.
          heading: 'Why Effluve Paris ?',
          item1: {
            title: 'Cruelty-free',
            body: 'We never test our products on animals.'
          },
          item2: {
            title: 'Long-lasting fragrance',
            // Reworded from "morning to night" -- the real figure (see S5's
            // own 8hrs stat, .stat1) is 8 hours, not an all-day claim.
            // "Among the longest" rather than "the longest" -- compelling
            // without an unverifiable absolute-superlative claim.
            body: 'An exceptional wear time of up to 8 hours, among the longest in the eau de parfum market.'
          },
          item3: {
            title: 'Satisfaction guaranteed',
            body: 'Returns and exchanges within 14 days.'
          },
          item4: {
            title: 'Ingredients imported from Italy',
            body: "Raw materials sourced from Italy's finest suppliers."
          }
        }
      },
      s1: {
        label: '001 | The Signature',
        heading: 'Composure Speaks Loudest.',
        body: "MONARK isn't sprayed, it's declared. A breath of bergamot and pink pepper cuts the air, sharp as a decision with no way back. Not softness, restraint with teeth."
      },
      s2: {
        label: '002 | The Genesis',
        heading: 'The Shell Was Never the Point.',
        body: "Glass breaks, and beneath the shards a black core emerges, molten, whole, the true shape the bottle concealed. MONARK follows the same law: stripped of his armor, a man doesn't weaken. He's revealed, undiluted."
      },
      s3: {
        label: '003 | The Composition',
        heading: 'What the Breaking Reveals.',
        tier1: {
          label: 'Opening | The First Strike',
          heading: '<span class="note-word-line"><span class="note-word" tabindex="0">Bergamot</span>.</span> <span class="note-word-line"><span class="note-word" tabindex="0">Lemon</span>.</span><br><span class="note-word-line"><span class="note-word" tabindex="0">Pink Pepper</span>.</span>',
          body: "The opening cuts, it doesn't greet. Italian bergamot, bright lemon, lifted by the dry heat of pink pepper, an introduction that ends conversation before it starts."
        },
        tier2: {
          label: 'The Heart | What Remains',
          heading: '<span class="note-word-line"><span class="note-word" tabindex="0">Lavender</span>.</span> <span class="note-word-line"><span class="note-word" tabindex="0">Geranium</span>.</span><br><span class="note-word-line"><span class="note-word" tabindex="0">Incense</span>.</span>',
          body: 'Beneath the strike settles something older. Lavender and geranium soften just enough to let incense rise, smoke from a private ritual, closed to everyone else.'
        },
        tier3: {
          label: 'The Base | What Lasts',
          heading: '<span class="note-word-line"><span class="note-word" tabindex="0">Ambergris</span>.</span> <span class="note-word-line"><span class="note-word" tabindex="0">Cedarwood</span>.</span><br><span class="note-word-line"><span class="note-word" tabindex="0">Musk</span>.</span>',
          body: "This is what stays on skin, long after the room empties. Ambergris and cedarwood root the blend in something old; musk shuts the door. You don't wear this scent. You leave it behind."
        }
      },
      s4: {
        label: '004 | The Provenance',
        heading: 'Rare as a Crown, Without Compromise.',
        body: "Cedar comes from a single forest in the Atlas Mountains. Ambergris ages long before the blend. Every MONARK batch is mixed by hand, in quantities too small to rush, too precise to repeat exactly. That's the point."
      },
      s5: {
        label: '005 | In Numbers',
        stat1: 'Sillage that lingers past midnight',
        stat2: 'Eau de Parfum concentration',
        // Reworded from "Countries of origin, for nine raw materials" --
        // neither number was backed by real per-ingredient data (see
        // index.html's own markup comment on this stat). Animated as "1"
        // (this section's existing data-value count-up pattern) rather than
        // the country name itself; stat3caption is the small sub-caption
        // under the label that actually names the country (Italy).
        stat3: 'Country of manufacture',
        stat3caption: 'Made in Italy',
        stat4: 'Bottles per edition'
      },
      s6: {
        label: '006 | The Acquisition',
        heading: 'The Reign Is Bottled. Claim Yours.',
        body: 'A scent built for men who rule rooms without entering them.',
        badge: 'Limited-Time Offer : −21% Off',
        button: 'Acquire MONARK | 100ml',
        note: 'Ships in a matte black box, wrapped in protective plastic.'
      },
      footer: {
        copyright: '© 2026 Effluve Paris. All rights reserved.',
        faq: 'FAQ',
        contact: 'Contact',
        legalNotice: 'Legal Notice',
        termsOfSale: 'Terms of Sale',
        privacyPolicy: 'Privacy Policy'
      },
      navMenu: {
        openMenu: 'Open menu',
        closeMenu: 'Close menu',
        siteMenu: 'Site menu',
        homepage: 'Homepage',
        checkout: 'Checkout',
        info: 'Info',
        account: 'Account',
        langSwitchToFr: 'Switch to French',
        langSwitchToEn: 'Switch to English',
        faq: 'FAQ',
        contact: 'Contact',
        legalNotice: 'Legal Notice',
        termsOfSale: 'Terms of Sale',
        privacyPolicy: 'Privacy Policy'
      },
      cookie: {
        ariaLabel: 'Cookie consent',
        text: 'We use cookies to improve your experience and analyze site traffic. Read our <a href="confidentialite.html">privacy policy</a> to learn more.',
        reject: 'Reject',
        accept: 'Accept'
      },
      emailPopup: {
        ariaLabel: 'Email signup offer',
        close: 'Close',
        kicker: 'A Small Concession',
        heading: 'Get 10% Off Your First Bottle',
        copy: "Join the list before we run out of bottles.",
        emailPlaceholder: 'you@email.com',
        emailAriaLabel: 'Email address',
        consent: 'By submitting, you agree to receive marketing emails from Effluve Paris.',
        submit: 'Claim My 10%',
        errorEmpty: 'Please enter your email.',
        errorInvalid: 'Please enter a valid email address.',
        confirmedKicker: 'Confirmed',
        confirmedHeading: 'Your Code: {code}',
        confirmedCopy: '10% off your first bottle, enter it at checkout. Sent to {email} too, for safekeeping.',
        newsletterDisclosure: "You've also been subscribed to our newsletter."
      },
      promoBanner: {
        ariaLabel: 'Promotional offer',
        // No trailing space (used to have one) -- this text sits inside
        // .promo-banner-timer-label, which is underlined; a trailing space
        // baked into the string got underlined too, stretching the line
        // into the gap before the countdown chip. The gap itself now comes
        // from margin-left on .promo-banner-timer/.promo-countdown-value
        // instead (see css/style.css).
        endsIn: 'Offer ends in',
        dismiss: 'Dismiss'
      },
      cartWidget: {
        viewCart: 'View cart',
        viewCartCount: 'View cart, {count} item',
        viewCartCountPlural: 'View cart, {count} items',
        previewDialogLabel: 'Shopping cart preview',
        closePreview: 'Close cart preview',
        empty: 'Your cart is empty.',
        decreaseQty: 'Decrease quantity',
        increaseQty: 'Increase quantity',
        quantity: 'Quantity',
        removeItem: 'Remove item from cart',
        addAnother: 'Add Another',
        buyNow: 'Buy Now'
      },
      common: {
        backToShop: '← Back to Shop',
        account: 'Account',
        placesSuggestionsLabel: 'Suggestions',
        errorNameFormat: 'Please use only letters, spaces, hyphens, and apostrophes (max 50 characters).'
      },
      product: {
        carouselAriaLabel: 'MONARK bottle image carousel',
        imgAltStudio: 'MONARK Eau de Parfum bottle — studio view',
        imgAltDetail: 'MONARK Eau de Parfum bottle — detail view',
        zoomStudio: 'Zoom in on studio view',
        zoomDetail: 'Zoom in on detail view',
        dotStudio: 'Show studio view',
        dotDetail: 'Show detail view',
        closeLightbox: 'Close lightbox',
        imageViewerAriaLabel: 'Image viewer',
        kicker: 'Eau de Parfum | 100ml',
        scentNotes: 'Bergamot · Incense · Amber',
        // Stock progress bar's own label (see product.html's inline script,
        // renderStock()) -- deliberately doesn't show the {total} ceiling
        // (odd to tell a customer "out of 500"), just the remaining count.
        stockLabel: 'Only {count} left in stock',
        addToCart: 'Add to Cart — 100ML',
        // Sticky mobile buy bar only (product.html) -- shorter than the main
        // page's own addToCart above since the bar is a compact, persistent
        // strip, not the hero's spacious CTA row. Separate key so this
        // page's two Add to Cart buttons can read differently without one
        // affecting the other.
        stickyAddToCart: 'Add to Cart',
        // Keyboard-only fallback for the Payment Request Button (Apple
        // Pay/Google Pay/Link) -- invisible to mouse/touch users, who see
        // and use Stripe's own rendered button instead; only ever shown to
        // a keyboard user once Tab focus actually reaches it, so the label
        // needs to stand alone (no visual wallet logo next to it) rather
        // than mirror Stripe's own wordmark-only button text.
        paymentRequestFallback: 'Pay with Apple Pay, Google Pay, or Link',
        returnPolicy: {
          summary: '14-Day Return Policy',
          body: 'You may return your unopened MONARK bottle within 14 days of delivery for a full refund, no questions asked. Once the original plastic packaging has been opened, the bottle can no longer be returned for hygiene reasons, per EU consumer protection law. Read the full terms in our <a href="cgv.html">Terms &amp; Conditions of Sale</a>.'
        },
        howToWear: {
          summary: 'How to Wear',
          step1: "Apply to pulse points (wrists & neck) right after showering, while skin is still damp.",
          step2: "Don't rub wrists together. It breaks the scent down before it has a chance to open.",
          step3: 'Two to three sprays for daytime. Layer sparingly for an evening presence.',
          step4: 'Reapply after 6–8 hours if the moment calls for it.'
        },
        ingredients: {
          summary: 'Full Ingredients List (INCI)',
          allergensNote: 'May contain allergens regulated under EU cosmetic regulation (full list available on request).'
        },
        shippingFaqLink: 'Shipping, returns & more — FAQ',
        notesKicker: 'The Composition',
        topNotes: 'Top Notes',
        topNotesNames: '<span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-bergamot">Bergamot</span><span class="note-desc" id="note-desc-bergamot">Bright, citrus opening</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-lemon">Lemon</span><span class="note-desc" id="note-desc-lemon">Sharp, sunlit zest</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-pinkpepper">Pink Pepper</span><span class="note-desc" id="note-desc-pinkpepper">Dry, peppered heat</span></span>',
        heartNotes: 'Heart Notes',
        heartNotesNames: '<span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-lavender">Lavender</span><span class="note-desc" id="note-desc-lavender">Soft herbal calm</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-geranium">Geranium</span><span class="note-desc" id="note-desc-geranium">Green, rosy depth</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-incense">Incense</span><span class="note-desc" id="note-desc-incense">Smoke, quiet ritual</span></span>',
        baseNotes: 'Base Notes',
        baseNotesNames: '<span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-ambergris">Ambergris</span><span class="note-desc" id="note-desc-ambergris">Warm, ancient amber</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-cedarwood">Cedarwood</span><span class="note-desc" id="note-desc-cedarwood">Dry, rooted wood</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-musk">Musk</span><span class="note-desc" id="note-desc-musk">Skin-close, lingering</span></span>',
        // Real reviews from actual product testers (first name + last initial,
        // consent confirmed for that level of attribution) -- exactly 3 written
        // testimonials, deliberately not a star-rating/aggregate system (no
        // aggregate data exists to back one). See product.html's .shop-reviews
        // section and css/shop.css for the card styling this feeds.
        reviews: {
          heading: "What They're Saying",
          review1: {
            quote: "I've finally found a scent that feels like me. The notes are exactly as described, and it genuinely lasts all day without ever becoming overpowering.\n\nI get compliments almost every time I wear it!",
            name: 'Camille R.',
            label: 'Verified customer'
          },
          review2: {
            quote: "What really surprised me was the longevity. My other perfumes usually fade within a few hours, but this one is still there by evening.\n\nThe quality genuinely shows, you can tell it's not a cheap formula.",
            name: 'Julien P.',
            label: 'Verified customer'
          },
          review3: {
            quote: "A subtle scent that still leaves a real trail behind you. Not too strong, not too light, exactly the balance I was looking for.\n\nI haven't wanted to switch since I discovered it.",
            name: 'Sophie L.',
            label: 'Verified customer'
          }
        },
        // Newsletter signup section, below Customer Reviews -- shares its
        // form/input/button/consent/error/confirmation copy with the
        // site-wide email popup (see emailPopup.* and js/email-popup.js's
        // window.MonarkEmailCapture) rather than duplicating any of it; only
        // this section's own heading/body/submit label are unique to it.
        newsletter: {
          heading: 'Stay Informed',
          body: 'New editions, occasional offers, nothing more.',
          submit: 'Subscribe'
        }
      },
      checkout: {
        title: 'Checkout',
        thankYou: 'Thank You',
        orderSummary: 'Order Summary',
        promoCodeLabel: 'Promo Code',
        promoPlaceholder: 'Enter code',
        apply: 'Apply',
        whatsappSupportLabel: '24/7 customer service',
        whatsappHref: 'https://api.whatsapp.com/send?phone=33605893897&text=Hello%2C%20I%20have%20a%20question.',
        shippingInformation: 'Shipping Information',
        firstName: 'First Name',
        lastName: 'Last Name',
        address: 'Address',
        country: 'Country',
        countryFR: 'France',
        countryBE: 'Belgium',
        city: 'City',
        postalCode: 'Postal Code',
        payment: 'Billing',
        // Divider between the Payment Request Button (Apple Pay/Google
        // Pay/Link) and the card form below -- only ever shown once that
        // button itself is (see initPaymentRequestButton() in checkout.html's
        // inline script), so a wallet-less browser never sees a stray "or"
        // with nothing above it.
        orDivider: 'or',
        stripeInitError: 'Could not load the payment form. Please refresh the page and try again.',
        stripeNotReady: "The payment form isn't ready yet. Please wait a moment and try again.",
        stripeGenericError: 'Payment failed. Please try again.',
        placeOrder: 'Place Order',
        orderReceived: 'Order Received',
        confirmationText: 'Your payment was processed and your order has been recorded. No confirmation email is sent yet — that’s a follow-up.',
        backToTheExperience: 'Back to The Experience',
        errorFirstName: 'Please enter your first name.',
        errorLastName: 'Please enter your last name.',
        errorAddress: 'Please enter your address.',
        errorCity: 'Please enter your city.',
        errorPostal: 'Please enter your postal code.',
        errorPostalFormat: 'Please enter a valid {digits}-digit postal code.',
        errorCountry: 'Shipping is currently only available to France and Belgium.',
        emptyCartNote: 'Your cart is empty. <a href="product.html">Shop MONARK</a> first.',
        qty: 'Qty',
        subtotal: 'Subtotal',
        shipping: 'Shipping',
        vat: 'VAT',
        free: 'Free',
        limitedTimeOffer: 'Limited-Time Offer (−21%)',
        promoLabel: 'Promo ({code})',
        total: 'Total',
        promoSuccess: 'Applied ✓ {percent}% off',
        promoInvalid: 'Invalid code',
        confirmationTotalWithCode: 'Total charged: {total} (promo {code} applied)',
        confirmationTotal: 'Total charged: {total}',
        statusGuest: 'Checking out as {email} (Guest)',
        nextStep: 'Next Step',
        accordionAccountSummaryGuest: '{email} (Guest)',
        accordionShippingSummary: 'Shipping to: {name}, {city}',
        // Label text changed from "Address Line 2 (optional)" -- literally
        // contained "Address", which Chrome's autofill heuristic reads as
        // part of its field classification via the <label> this input is
        // wrapped in, independent of the name/id/autocomplete attributes
        // (already fixed separately, see checkout.html's own input comment)
        // -- so the word itself needed to go, not just the DOM attributes.
        // Field itself (name="extraDetails", optional, free text) is
        // unchanged; only this visible wording changed.
        addressLine2: 'Building, floor, access code… (optional)',
        phone: 'Phone Number (optional)',
        termsLabel: 'I accept the <a href="cgv.html" target="_blank" rel="noopener">Terms &amp; Conditions of Sale</a>.',
        errorTerms: 'Please accept the Terms & Conditions of Sale to continue.',
        mobileOrderSummaryHeading: 'Payment',
        cartHeading: 'Cart',
        // Trust-badge row below the accordion (see checkout.html's own markup
        // comment) -- three short labels, one per icon, never longer than a
        // couple of words since they wrap under a small fixed-width icon.
        trustShipping: 'Free shipping',
        trustReturns: 'Returns & exchanges',
        trustPayment: 'Secure payment'
      },
      accountGate: {
        modify: 'Modify',
        modifyEmail: 'Modify Email',
        cancelEdit: 'Cancel',
        createAccountBtn: 'Create Account',
        emailExistsNote: 'This email is already linked to an account. Please log in.',
        loggedInAs: 'Logged in as {email}',
        guestDefault: 'Continuing as {email} (Guest)',
        intro: 'Please enter your email to continue as a guest, log in, or create an account.',
        emailLabel: 'Email',
        continueBtn: 'Continue',
        passwordLabel: 'Password',
        logInBtn: 'Log In',
        continueAsGuest: 'Continue as Guest',
        createAccountInstead: 'Create an account instead',
        confirmPasswordLabel: 'Confirm Password',
        createAccountAndContinue: 'Create Account & Continue',
        errorEmailEmpty: 'Please enter your email.',
        errorEmailInvalid: 'Please enter a valid email address.',
        errorWrongPassword: 'Incorrect password.',
        errorAccountNotFound: 'Account not found.',
        errorPasswordWeak: 'Password must be at least 8 characters and include a letter and a number.',
        errorPasswordMismatch: 'Passwords do not match.',
        errorAccountExists: 'An account with this email already exists.',
        accountCreated: 'Your account has been created.',
        errorNameRequired: 'Please enter your first and last name.',
        errorNameFormat: 'First and last name may only contain letters, spaces, hyphens, and apostrophes (max 50 characters each).',
        errorGeneric: 'Something went wrong. Please try again.',
        errorRateLimited: 'Too many attempts right now. Please wait a few minutes and try again.',
        forgotPassword: 'Forgot password?',
        resetPasswordSent: 'A password reset email has been sent to {email}.',
        resetPasswordError: 'Could not send the reset email. Please check the address and try again.',
        confirmAccountPending: 'Check your inbox at {email} to confirm your account before logging in.',
        setNewPasswordHeading: 'Set a New Password',
        newPasswordLabel: 'New Password',
        setNewPasswordBtn: 'Set Password',
        phoneLabel: 'Phone Number (optional)',
        marketingLabel: 'I\'d like to receive product updates, promotions, and the MONARK newsletter by email. You can change this anytime from your Account page &mdash; see our <a href="confidentialite.html" target="_blank" rel="noopener">Privacy Policy</a> for details.'
      },
      phoneInput: {
        countrySelectorLabel: 'Country code',
        numberLabel: 'Phone number',
        searchLabel: 'Search countries',
        searchPlaceholder: 'Search countries',
        noResults: 'No countries found',
        errorInvalidFR: 'Please enter a valid French phone number (e.g. 6 12 34 56 78).',
        errorInvalidGeneric: 'Please enter a valid phone number.'
      },
      account: {
        pageTitle: 'My Account',
        statusGuest: 'Browsing as guest ({email})',
        logOut: 'Log Out',
        orderHistoryHeading: 'Order History',
        noOrdersYet: 'No orders yet — your past purchases will appear here.',
        editProfileHeading: 'Edit Profile',
        emailLabel: 'Email',
        passwordLabel: 'New Password',
        passwordHint: 'Leave blank to keep your current password.',
        firstNameLabel: 'First Name',
        lastNameLabel: 'Last Name',
        dobLabel: 'Date of Birth',
        saveProfileBtn: 'Save Changes',
        profileUpdated: 'Profile updated.',
        emailChangePending: 'Check your new email address to confirm the change.',
        addressHeading: 'Saved Shipping Address',
        addressLabel: 'Address',
        // Same "no literal Address wording" fix as checkout.addressLine2
        // above -- see that key's own comment.
        addressLine2Label: 'Building, floor, access code…',
        cityLabel: 'City',
        postalCodeLabel: 'Postal Code',
        phoneLabel: 'Phone Number',
        saveAddressBtn: 'Save Address',
        addressUpdated: 'Address updated.',
        paymentHeading: 'Saved Card',
        cardNameLabel: 'Name on Card',
        cardNumberLabel: 'Card Number',
        cardExpiryLabel: 'Expiry',
        paymentMockNote: 'Mocked for demo purposes — no real card data is stored or processed.',
        savePaymentBtn: 'Save Card',
        paymentUpdated: 'Card updated.',
        preferencesHeading: 'Preferences',
        marketingLabel: 'Receive marketing emails',
        savePreferencesBtn: 'Save Changes',
        preferencesUpdated: 'Preferences updated.',
        orderDate: 'Ordered {date}',
        orderQty: 'Qty {qty}',
        orderTotalLine: 'Total: {total}',
        guestOrderHistoryNote: 'Create an account to view your order history & more.',
        guestCreateAccountBtn: 'Create an Account',
        deleteAccountBtn: 'Delete Account',
        deleteConfirmText: 'Delete your account permanently?',
        deleteConfirmIrreversible: 'This action is irreversible.',
        deleteConfirmBtn: 'Confirm Delete',
        deleteCancelBtn: 'Cancel'
      },
      faq: {
        pageTitle: 'Frequently Asked Questions',
        intro: 'Everything you need to know before, during, and after you acquire MONARK.',
        shipping: {
          heading: 'Shipping & Delivery',
          body: 'Orders currently ship within 5&ndash;7 business days, to France and Belgium, with shipping always included in the price. Every bottle travels in its original box, wrapped in protective plastic, designed to arrive exactly as it left us.'
        },
        returns: {
          heading: 'Returns & Refunds',
          body: 'You have 14 days from delivery to return your MONARK bottle for a full refund, provided the original plastic packaging is still intact, once opened, the bottle can no longer be returned for hygiene reasons, per EU consumer protection law. Full terms, including how to initiate a return, are set out in our <a href="cgv.html">Terms & Conditions of Sale</a>.'
        },
        ingredients: {
          heading: 'Ingredients & Allergens',
          body: 'The full olfactory composition (top, heart, and base notes) is listed on the <a href="product.html">product page</a>. As with any fine fragrance, MONARK contains natural and synthetic aromatic compounds that can trigger sensitivities in some people, including common fragrance allergens regulated under EU cosmetics law (e.g. linalool, limonene). If you have known fragrance sensitivities, we recommend testing a small amount on skin before full application.'
        },
        storage: {
          heading: 'How should I store my MONARK bottle?',
          body: 'Keep it upright, away from direct sunlight and heat, ideally somewhere with a stable, cool temperature, a drawer or cabinet works better than a bathroom shelf or windowsill. Light and heat are what actually degrade a fragrance over time, not age alone. Stored properly, MONARK holds its character for years.'
        },
        promoCode: {
          heading: 'How do I use a promo code?',
          body: 'Enter your code in the Promo Code field on the checkout page and select "Apply", the discount is calculated automatically and reflected in your order total before you place your order. Only one code can be applied per order.'
        }
      },
      contact: {
        pageTitle: 'Contact',
        intro: 'Questions about an order, the composition, or a wholesale inquiry, we read every message personally.',
        reachUs: 'Reach us directly at <span class="placeholder">[CONTACT EMAIL — TO BE COMPLETED]</span>, or use the form below.',
        whatsappBtn: 'Contact us<br class="mobile-only-break"> on WhatsApp',
        whatsappHref: 'https://api.whatsapp.com/send?phone=33605893897&text=Hello%2C%20I%20have%20a%20question.',
        honeypotLabel: 'Leave this field blank',
        nameLabel: 'Name',
        emailLabel: 'Email',
        reasonLabel: 'Reason',
        reasonPlaceholder: 'Select one',
        reasonOrder: 'Order Inquiry',
        reasonWholesale: 'Wholesale',
        reasonPress: 'Press',
        reasonOther: 'Other',
        reasonError: 'Please select a reason.',
        messageLabel: 'Message',
        submitBtn: 'Send Message',
        successMessage: "Thank you — your message has been received. We'll get back to you shortly. (This is a mocked confirmation; no message was actually sent yet.)"
      },
      notFound: {
        heading: "This Room Doesn't Exist",
        body: "Some doors in this house lead nowhere, deliberately. The page you were looking for isn't one we've built, or it's since moved on. Nothing here to reign over.",
        backToExperience: 'Back to The Experience',
        acquireMonark: 'Acquire MONARK'
      },
      legalNotice: {
        pageTitle: 'Legal Notice',
        publisherHeading: 'Site Publisher',
        publisherBody1: 'The Effluve Paris website is published by <span class="placeholder">[COMPANY NAME — TO BE COMPLETED]</span>, <span class="placeholder">[LEGAL STRUCTURE — TO BE COMPLETED]</span> with share capital of <span class="placeholder">[SHARE CAPITAL — TO BE COMPLETED]</span>, registered with the Trade and Companies Register under SIRET number <span class="placeholder">[SIRET — TO BE COMPLETED]</span>.',
        publisherBody2: 'Registered office: <span class="placeholder">[ADDRESS — TO BE COMPLETED]</span><br>Intra-Community VAT number: <span class="placeholder">[VAT NUMBER — TO BE COMPLETED]</span>',
        directorHeading: 'Publication Director',
        directorBody: '<span class="placeholder">[PUBLICATION DIRECTOR NAME — TO BE COMPLETED]</span>',
        contactHeading: 'Contact',
        contactBody: 'For any questions regarding the site or this legal notice, you may contact us at the following address: <a href="mailto:effluvepariscontact@gmail.com">effluvepariscontact@gmail.com</a>',
        hostingHeading: 'Hosting',
        hostingBody: 'Cloudflare, Inc.',
        ipHeading: 'Intellectual Property',
        ipBody: 'All elements making up this site (text, images, logos, graphics, videos) are the exclusive property of Effluve Paris or its partners, unless otherwise stated, and are protected by intellectual property law. Any reproduction, representation, modification, or use, in whole or in part, without prior authorization is prohibited.',
        dataHeading: 'Personal Data',
        dataBody: 'The processing of your personal data is described in our <a href="confidentialite.html">privacy policy</a>.'
      },
      termsOfSale: {
        pageTitle: 'Terms & Conditions of Sale',
        intro: "These Terms & Conditions of Sale (\"Terms\") govern the sale of products made on the Effluve Paris website. Any order placed on this site implies the customer's unconditional acceptance of these Terms.",
        s1Heading: '1. Purpose',
        s1Body: 'These Terms are intended to define the rights and obligations of the parties in connection with the online sale of products offered by Effluve Paris, namely perfumes and related products.',
        s2Heading: '2. Price',
        s2Body: 'Product prices are shown in euros (€), all taxes included. Effluve Paris reserves the right to modify its prices at any time, it being understood that the price shown on the order at the time it is confirmed by the customer will be the only price applicable to that order.',
        s3Heading: '3. Order',
        s3Body: 'The customer selects the products they wish to order, adds them to their cart, then confirms the order after reviewing the summary. The order is only final once payment has been confirmed.',
        s4Heading: '4. Payment',
        s4Body: 'Payment is made online, at the time of ordering, by credit card or any other payment method offered on the site, via a secure payment provider: Stripe.',
        s5Heading: '5. Delivery',
        s5Body1: 'Products are delivered to the address provided by the customer when placing the order.',
        s5Body2: 'Delivery zones: France and Belgium.<br>Estimated delivery times: 5&ndash;7 business days.<br>Delivery fees: shipping is always free, included in the product price, not a threshold-based discount.',
        s6Heading: '6. Right of Withdrawal',
        s6Body1: 'In accordance with Articles L221-18 et seq. of the French Consumer Code, the customer has a period of fourteen (14) clear days from receipt of the product to exercise their right of withdrawal with Effluve Paris, without having to state any reason or pay any penalty, except, where applicable, for return shipping costs.',
        s6Body2: 'To exercise this right, the customer must notify their decision to withdraw by means of an unambiguous statement (postal mail, email, or withdrawal form) sent to <a href="mailto:effluvepariscontact@gmail.com">effluvepariscontact@gmail.com</a> before the 14-day period expires.',
        s6Body3: 'The customer then has a period of fourteen (14) days from the date they communicate their decision to withdraw to return the product. Effluve Paris will refund the full amount paid, including standard delivery costs, no later than fourteen (14) days after being informed of the decision to withdraw, unless Effluve Paris offers to collect the item itself or the customer does not provide proof of shipment, in which case the refund may be deferred until the item is received or proof of its shipment is provided, whichever occurs first.',
        s6Body4: '<strong>Exception:</strong> in accordance with Article L221-28 of the French Consumer Code, the right of withdrawal cannot be exercised for products unsealed by the customer after delivery that cannot be returned for hygiene or health protection reasons. A perfume bottle whose original plastic packaging has been removed or whose contents have been opened therefore cannot be the subject of a right of withdrawal, except in the case of non-conformity or a product defect.',
        s7Heading: '7. Returns and Refunds',
        s7Body: "Returns must be made in their original packaging, unsealed, accompanied by proof of purchase. Return shipping costs are the customer's responsibility, except in the case of a non-conforming or defective product. Refunds are issued using the same payment method used when placing the order.",
        s8Heading: '8. Warranties',
        s8Body: 'All products sold on the site benefit from the legal guarantee of conformity (Articles L217-3 et seq. of the French Consumer Code) and the legal guarantee against hidden defects (Articles 1641 et seq. of the French Civil Code).',
        s9Heading: '9. Disputes and Jurisdiction',
        s9Body: 'These Terms are governed by French law. In the event of a dispute, an amicable solution will be sought before any legal action, in particular via the consumer mediator <span class="placeholder">[MEDIATOR — TO BE COMPLETED]</span>. Failing an amicable agreement, the French courts shall have sole jurisdiction.'
      },
      privacyPolicy: {
        pageTitle: 'Privacy Policy',
        intro: 'This privacy policy describes how Effluve Paris collects, uses, and protects the personal data of users of this site, in accordance with the General Data Protection Regulation (GDPR | Regulation (EU) 2016/679) and the French Data Protection Act (Loi Informatique et Libertés).',
        s1Heading: '1. Data Collected',
        s1Intro: 'As part of your browsing and orders on the site, we may collect the following data:',
        s1Item1: 'Identity: first and last name',
        s1Item2: 'Contact details: email address, postal address, phone number',
        s1Item3: 'Order data: purchase history, products viewed',
        s1Item4: 'Payment data: processed directly by our payment provider; Effluve Paris does not have access to full banking details',
        s1Item5: 'Browsing data: IP address, cookies (see section 8)',
        s2Heading: '2. Purposes of Processing',
        s2Body: 'This data is collected for the following purposes: processing and tracking orders, managing the customer relationship, fraud prevention, improving the site and user experience, and, subject to your consent, sending marketing communications.',
        s3Heading: '3. Legal Basis for Processing',
        s3Body: "The processing of your data is based, depending on the case, on: performance of the sales contract (for order processing), consent (for the newsletter and non-essential cookies), Effluve Paris's legitimate interest (service improvement, security), and compliance with legal obligations (invoicing, accounting).",
        s4Heading: '4. Data Retention Period',
        s4Body: 'Your data is retained for the period necessary to fulfill the purposes for which it was collected, and in particular: order-related data is retained for the period required by accounting and tax obligations (10 years); prospect data is retained for 3 years from the last contact.',
        s5Heading: '5. Your Rights',
        s5Intro: 'In accordance with Articles 15 to 22 of the GDPR, you have the following rights over your personal data:',
        s5Right1: '<strong>Right of access</strong>: to obtain confirmation that your data is being processed and to obtain a copy of it;',
        s5Right2: '<strong>Right to rectification</strong>: to have inaccurate or incomplete data corrected;',
        s5Right3: '<strong>Right to erasure</strong> ("right to be forgotten"): to request the deletion of your data, under the conditions provided for by the GDPR;',
        s5Right4: '<strong>Right to restriction of processing</strong>;',
        s5Right5: '<strong>Right to data portability</strong>: to receive your data in a structured, commonly used, machine-readable format, and to transmit it to another data controller;',
        s5Right6: '<strong>Right to object</strong>, in particular to processing for prospecting purposes;',
        s5Right7: '<strong>Right to withdraw your consent</strong> at any time, where processing is based on it.',
        s5Cnil: 'You also have the right to lodge a complaint with the French Data Protection Authority (CNIL) if you believe that the processing of your personal data constitutes a breach of the GDPR.',
        s6Heading: '6. Recipients and Third Parties',
        s6Body: 'Your data may be shared with the following recipients, strictly limited to their respective needs: our payment provider for processing transactions (Stripe), our hosting provider (Cloudflare, Inc.), and our delivery providers. These third parties are required to respect the confidentiality and security of your data.',
        transfersHeading: '7. International Data Transfers',
        transfersIntro: 'As part of using our technical service providers, some data may be processed outside the European Union:',
        transfersItem1: 'Hosting (Cloudflare, Inc.): a company based in the United States, operating a global network of servers.',
        transfersItem2: 'Database (Supabase Pte. Ltd.): a company based in Singapore; our data is hosted and primarily processed in Ireland (EU), but Supabase relies on subprocessors based in the United States (including Amazon Web Services, Google, Cloudflare) for its hosting and support services.',
        transfersItem3: 'Payment (Stripe, LLC / Stripe Payments Europe Limited): a company based in the United States, with a European subsidiary (Ireland); some data passes through US-based subprocessors (Twilio, Google, Salesforce) as part of payment processing and technical support.',
        transfersItem4: 'Fonts (Google Fonts): company based in the United States.',
        transfersSafeguards: 'These transfers are governed by the European Commission\'s Standard Contractual Clauses, ensuring an adequate level of protection for your personal data.',
        s7Heading: '8. Cookies',
        s7Body: 'This site uses cookies to improve your browsing experience, measure site traffic, and, subject to your consent, for personalization purposes. You can accept or reject non-essential cookies via the consent banner shown on your first visit. You can also change your preferences at any time by clearing the browsing data stored by your browser for this site.',
        s8Heading: '9. Contact',
        s8Body: 'For any questions regarding your personal data or to exercise your rights, you may contact our Data Protection Officer (DPO) at the following address: <a href="mailto:effluvepariscontact@gmail.com">effluvepariscontact@gmail.com</a>'
      }
    },
    fr: {
      a11y: {
        skipToContent: 'Aller au contenu',
        previousImage: 'Image précédente',
        nextImage: 'Image suivante'
      },
      nav: {
        experience: "L'Expérience",
        acquire: 'Acquérir'
      },
      hero: {
        label: 'Eau de Parfum',
        tagline: "Un parfum conçu pour les hommes qui règnent sur une pièce sans jamais y entrer.",
        subtext: 'Cliquez pour découvrir',
        scroll: 'Défilez pour que le Règne commence'
      },
      home: {
        whyEffluve: {
          // FR keeps the two-line mobile break (.mobile-only-break, see
          // css/style.css); EN does not -- see the EN heading's comment
          // above for why.
          heading: 'Pourquoi<br class="mobile-only-break"> Effluve Paris ?',
          item1: {
            title: 'Sans cruauté',
            body: "Nous ne testons jamais nos produits sur les animaux."
          },
          item2: {
            title: 'Parfum longue tenue',
            body: "Une tenue exceptionnelle allant jusqu'à 8 heures, parmi les plus longues du marché pour une eau de parfum."
          },
          item3: {
            title: 'Satisfait ou remboursé',
            body: 'Retours et échanges sous 14 jours.'
          },
          item4: {
            title: "Ingrédients importés d'Italie",
            body: 'Des matières premières sélectionnées auprès des meilleurs fournisseurs italiens.'
          }
        }
      },
      s1: {
        label: '001 | La Signature',
        heading: "Rien ne Parle Plus Fort que le Sang-Froid.",
        body: "MONARK ne se vaporise pas, il se déclare. Un souffle de bergamote et de poivre rose fend l'air, tranchant comme une décision sans retour. Pas de douceur ici, une retenue qui mord."
      },
      s2: {
        label: "002 | L'Éveil",
        heading: "Sous la Coquille, l'Essentiel.",
        body: "Le verre se brise, et sous les éclats surgit un noyau noir, fondu, entier, la forme véritable que le flacon dissimulait. MONARK suit la même loi : dépouillé de son armure, un homme ne s'affaiblit pas. Il se révèle, sans dilution."
      },
      s3: {
        label: '003 | La Composition',
        heading: 'Ce Que la Brisure Révèle.',
        tier1: {
          label: 'Tête | La Première Frappe',
          heading: '<span class="note-word-line"><span class="note-word" tabindex="0">Bergamote</span>.</span> <span class="note-word-line"><span class="note-word" tabindex="0">Citron</span>.</span><br><span class="note-word-line"><span class="note-word" tabindex="0">Poivre Rose</span>.</span>',
          body: "Aucune politesse ici, seulement une lame. Bergamote italienne, citron éclatant, rehaussés par la chaleur sèche du poivre rose, une entrée en matière qui coupe court à toute conversation."
        },
        tier2: {
          label: 'Le Cœur | Ce Qui Demeure',
          heading: '<span class="note-word-line"><span class="note-word" tabindex="0">Lavande</span>.</span> <span class="note-word-line"><span class="note-word" tabindex="0">Géranium</span>.</span><br><span class="note-word-line"><span class="note-word" tabindex="0">Encens</span>.</span>',
          body: "Sous la frappe s'installe quelque chose de plus ancien. Lavande et géranium adoucissent juste assez pour laisser monter l'encens, la fumée d'un rituel intime, fermé à tous les autres."
        },
        tier3: {
          label: 'Le Fond | Ce Qui Persiste',
          heading: '<span class="note-word-line"><span class="note-word" tabindex="0">Ambre Gris</span>.</span> <span class="note-word-line"><span class="note-word" tabindex="0">Bois de Cèdre</span>.</span><br><span class="note-word-line"><span class="note-word" tabindex="0">Musc</span>.</span>',
          body: "Ce qui reste sur la peau, une fois la pièce vide. Ambre gris et bois de cèdre ancrent la composition dans l'ancien ; le musc referme la porte. Ce parfum ne se porte pas, il se laisse derrière soi."
        }
      },
      s4: {
        label: '004 | La Provenance',
        heading: "Rare Comme une Couronne, Sans Compromis.",
        body: "Le cèdre vient d'une seule forêt de l'Atlas. L'ambre gris vieillit longtemps avant l'assemblage. Chaque lot MONARK est mélangé à la main, en quantités trop restreintes pour être précipitées, trop précises pour être reproduites à l'identique. C'est précisément le but."
      },
      s5: {
        label: '005 | En Chiffres',
        stat1: 'Un sillage qui persiste après minuit',
        stat2: 'Concentration en Eau de Parfum',
        stat3: 'Pays de fabrication',
        stat3caption: 'Fabriqué en Italie',
        stat4: 'Flacons par édition'
      },
      s6: {
        label: "006 | L'Acquisition",
        heading: 'Le Règne Est Mis en Flacon. Réclamez le Vôtre.',
        body: "Un parfum conçu pour les hommes qui règnent sur une pièce sans jamais y entrer.",
        badge: 'Offre Limitée : −21%',
        button: 'Acquérir MONARK | 100ml',
        note: 'Expédié dans une boîte noire mate, enveloppée d\'un film plastique protecteur.'
      },
      footer: {
        copyright: '© 2026 Effluve Paris. Tous droits réservés.',
        faq: 'FAQ',
        contact: 'Contact',
        legalNotice: 'Mentions Légales',
        termsOfSale: 'Conditions de Vente',
        privacyPolicy: 'Politique de Confidentialité'
      },
      navMenu: {
        openMenu: 'Ouvrir le menu',
        closeMenu: 'Fermer le menu',
        siteMenu: 'Menu du site',
        homepage: 'Accueil',
        checkout: 'Commande',
        info: 'Info',
        account: 'Compte',
        langSwitchToFr: 'Passer en français',
        langSwitchToEn: 'Switch to English',
        faq: 'FAQ',
        contact: 'Contact',
        legalNotice: 'Mentions Légales',
        termsOfSale: 'Conditions de Vente',
        privacyPolicy: 'Politique de Confidentialité'
      },
      cookie: {
        ariaLabel: 'Consentement aux cookies',
        text: 'Nous utilisons des cookies pour améliorer votre expérience et analyser le trafic du site. Consultez notre <a href="confidentialite.html">politique de confidentialité</a> pour en savoir plus.',
        reject: 'Refuser',
        accept: 'Accepter'
      },
      emailPopup: {
        ariaLabel: "Offre d'inscription par e-mail",
        close: 'Fermer',
        kicker: 'Une Petite Concession',
        heading: '10% de Réduction sur Votre Premier Flacon',
        copy: "Inscrivez-vous avant qu'il n'y ait plus de flacons disponibles.",
        emailPlaceholder: 'vous@email.com',
        emailAriaLabel: 'Adresse e-mail',
        consent: "En soumettant ce formulaire, vous acceptez de recevoir des e-mails marketing d'Effluve Paris.",
        submit: 'Obtenir Mes 10%',
        errorEmpty: 'Veuillez saisir votre e-mail.',
        errorInvalid: 'Veuillez saisir une adresse e-mail valide.',
        confirmedKicker: 'Confirmé',
        confirmedHeading: 'Votre Code : {code}',
        confirmedCopy: '10% de réduction sur votre premier flacon, à saisir lors du paiement. Également envoyé à {email}, pour vos archives.',
        newsletterDisclosure: 'Vous avez également été inscrit(e) à notre newsletter.'
      },
      promoBanner: {
        ariaLabel: 'Offre promotionnelle',
        endsIn: "Fin de l'offre dans",
        dismiss: 'Fermer'
      },
      cartWidget: {
        viewCart: 'Voir le panier',
        viewCartCount: 'Voir le panier, {count} article',
        viewCartCountPlural: 'Voir le panier, {count} articles',
        previewDialogLabel: "Aperçu du panier",
        closePreview: "Fermer l'aperçu du panier",
        empty: 'Votre panier est vide.',
        decreaseQty: 'Diminuer la quantité',
        increaseQty: 'Augmenter la quantité',
        quantity: 'Quantité',
        removeItem: "Retirer l'article du panier",
        addAnother: 'Ajouter un Autre',
        buyNow: 'Acheter'
      },
      common: {
        backToShop: '← Retour à la Boutique',
        account: 'Compte',
        placesSuggestionsLabel: 'Adresses suggérées',
        errorNameFormat: "Veuillez utiliser uniquement des lettres, espaces, tirets et apostrophes (50 caractères maximum)."
      },
      product: {
        carouselAriaLabel: "Carrousel d'images du flacon MONARK",
        imgAltStudio: 'Flacon MONARK Eau de Parfum — vue studio',
        imgAltDetail: 'Flacon MONARK Eau de Parfum — vue détaillée',
        zoomStudio: 'Zoomer sur la vue studio',
        zoomDetail: 'Zoomer sur la vue détaillée',
        dotStudio: 'Afficher la vue studio',
        dotDetail: 'Afficher la vue détaillée',
        closeLightbox: 'Fermer la visionneuse',
        imageViewerAriaLabel: "Visionneuse d'image",
        kicker: 'Eau de Parfum | 100ml',
        scentNotes: 'Bergamote · Encens · Ambre',
        stockLabel: 'Plus que {count} en stock',
        addToCart: 'Ajouter au Panier — 100ML',
        stickyAddToCart: 'Ajouter au Panier',
        paymentRequestFallback: 'Payer avec Apple Pay, Google Pay ou Link',
        returnPolicy: {
          summary: 'Retours sous 14 Jours',
          body: "Vous pouvez retourner votre flacon MONARK non ouvert dans les 14 jours suivant la livraison pour un remboursement intégral, sans questions. Une fois l'emballage plastique d'origine ouvert, le flacon ne peut plus être retourné pour des raisons d'hygiène, conformément au droit européen de la consommation. Consultez les conditions complètes dans nos <a href=\"cgv.html\">Conditions Générales de Vente</a>."
        },
        howToWear: {
          summary: 'Comment le Porter',
          step1: 'Appliquez sur les points de pulsation (poignets & cou) juste après la douche, pendant que la peau est encore humide.',
          step2: "Ne frottez pas les poignets l'un contre l'autre. Cela dégrade le parfum avant même qu'il ait pu s'ouvrir.",
          step3: 'Deux à trois vaporisations pour la journée. Superposez avec parcimonie pour une présence en soirée.',
          step4: "Réappliquez après 6 à 8 heures si l'occasion le demande."
        },
        ingredients: {
          summary: 'Liste Complète des Ingrédients (INCI)',
          allergensNote: 'Peut contenir des allergènes réglementés selon la réglementation cosmétique UE (liste complète disponible sur demande).'
        },
        shippingFaqLink: 'Livraison, retours et plus — FAQ',
        notesKicker: 'La Composition',
        topNotes: 'Notes de Tête',
        topNotesNames: '<span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-bergamot">Bergamote</span><span class="note-desc" id="note-desc-bergamot">Ouverture agrume, lumineuse</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-lemon">Citron</span><span class="note-desc" id="note-desc-lemon">Zeste vif, ensoleillé</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-pinkpepper">Poivre Rose</span><span class="note-desc" id="note-desc-pinkpepper">Chaleur sèche, poivrée</span></span>',
        heartNotes: 'Notes de Cœur',
        heartNotesNames: '<span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-lavender">Lavande</span><span class="note-desc" id="note-desc-lavender">Calme herbacé, doux</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-geranium">Géranium</span><span class="note-desc" id="note-desc-geranium">Profondeur verte, rosée</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-incense">Encens</span><span class="note-desc" id="note-desc-incense">Fumée, rituel silencieux</span></span>',
        baseNotes: 'Notes de Fond',
        baseNotesNames: '<span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-ambergris">Ambre Gris</span><span class="note-desc" id="note-desc-ambergris">Ambre chaud, ancien</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-cedarwood">Bois de Cèdre</span><span class="note-desc" id="note-desc-cedarwood">Bois sec, enraciné</span></span> &middot; <span class="note-word-wrap"><span class="note-word" tabindex="0" aria-describedby="note-desc-musk">Musc</span><span class="note-desc" id="note-desc-musk">Proche peau, persistant</span></span>',
        reviews: {
          heading: "Ce qu'ils en disent",
          review1: {
            quote: "J'ai enfin trouvé un parfum qui me ressemble. Les fragrances sont vraiment fidèles à la description, et surtout, ça tient toute la journée sans devenir écœurant.\n\nJe reçois souvent des compliments quand je le porte !",
            name: 'Camille R.',
            label: 'Cliente vérifiée'
          },
          review2: {
            quote: "Ce qui m'a vraiment choqué, c'est la tenue. D'habitude mes parfums s'estompent après quelques heures, lui est encore présent le soir même.\n\nLa qualité est vraiment au rendez-vous, on sent que ce n'est pas du bas de gamme.",
            name: 'Julien P.',
            label: 'Client vérifié'
          },
          review3: {
            quote: "Un parfum discret mais qui laisse une vraie trace derrière soi. Ni trop fort, ni trop léger, exactement l'équilibre que je cherchais.\n\nJe ne veux plus changer depuis que je l'ai découvert.",
            name: 'Sophie L.',
            label: 'Cliente vérifiée'
          }
        },
        newsletter: {
          heading: 'Restez Informé',
          body: 'Nouvelles éditions, offres occasionnelles, rien de plus.',
          submit: "S'abonner"
        }
      },
      checkout: {
        title: 'Commande',
        thankYou: 'Merci',
        orderSummary: 'Récapitulatif de la Commande',
        promoCodeLabel: 'Code Promo',
        promoPlaceholder: 'Entrez le code',
        apply: 'Appliquer',
        whatsappSupportLabel: 'Service client 24/7',
        whatsappHref: "https://api.whatsapp.com/send?phone=33605893897&text=Bonjour%2C%20j%27ai%20une%20question.",
        shippingInformation: 'Informations de Livraison',
        firstName: 'Prénom',
        lastName: 'Nom',
        address: 'Adresse',
        country: 'Pays',
        countryFR: 'France',
        countryBE: 'Belgique',
        city: 'Ville',
        postalCode: 'Code Postal',
        payment: 'Facturation',
        orDivider: 'ou',
        stripeInitError: 'Impossible de charger le formulaire de paiement. Veuillez actualiser la page et réessayer.',
        stripeNotReady: "Le formulaire de paiement n'est pas encore prêt. Veuillez patienter un instant et réessayer.",
        stripeGenericError: 'Le paiement a échoué. Veuillez réessayer.',
        placeOrder: 'Passer la Commande',
        orderReceived: 'Commande Reçue',
        confirmationText: "Votre paiement a été traité et votre commande a été enregistrée. Aucun e-mail de confirmation n'est encore envoyé — ce sera une prochaine étape.",
        backToTheExperience: "Retour à L'Expérience",
        errorFirstName: 'Veuillez saisir votre prénom.',
        errorLastName: 'Veuillez saisir votre nom.',
        errorAddress: 'Veuillez saisir votre adresse.',
        errorCity: 'Veuillez saisir votre ville.',
        errorPostal: 'Veuillez saisir votre code postal.',
        errorPostalFormat: 'Veuillez saisir un code postal valide à {digits} chiffres.',
        errorCountry: "La livraison n'est actuellement disponible qu'en France et en Belgique.",
        emptyCartNote: 'Votre panier est vide. <a href="product.html">Découvrez MONARK</a> avant de continuer.',
        qty: 'Qté',
        subtotal: 'Sous-total',
        shipping: 'Livraison',
        vat: 'TVA',
        free: 'Offerte',
        limitedTimeOffer: 'Offre à Durée Limitée (−21%)',
        promoLabel: 'Promo ({code})',
        total: 'Total',
        promoSuccess: 'Appliqué ✓ {percent}% de réduction',
        promoInvalid: 'Code invalide',
        confirmationTotalWithCode: 'Total facturé : {total} (code promo {code} appliqué)',
        confirmationTotal: 'Total facturé : {total}',
        statusGuest: "Commande en tant qu'invité : {email}",
        nextStep: 'Étape Suivante',
        accordionAccountSummaryGuest: '{email} (Invité)',
        accordionShippingSummary: 'Livraison à : {name}, {city}',
        addressLine2: "Bâtiment, étage, code d'accès… (facultatif)",
        phone: 'Numéro de Téléphone (facultatif)',
        termsLabel: "J'accepte les <a href=\"cgv.html\" target=\"_blank\" rel=\"noopener\">Conditions Générales de Vente</a>.",
        errorTerms: 'Veuillez accepter les Conditions Générales de Vente pour continuer.',
        mobileOrderSummaryHeading: 'Paiement',
        cartHeading: 'Panier',
        trustShipping: 'Livraison gratuite',
        trustReturns: 'Retours & échanges',
        trustPayment: 'Paiement sécurisé'
      },
      accountGate: {
        modify: 'Modifier',
        modifyEmail: 'Modifier l\'email',
        cancelEdit: 'Annuler',
        createAccountBtn: 'Création compte',
        emailExistsNote: 'Cet e-mail est déjà associé à un compte. Veuillez vous connecter.',
        loggedInAs: 'Connecté en tant que {email}',
        guestDefault: 'Poursuite en tant que {email} (Invité)',
        intro: "Veuillez saisir votre e-mail pour continuer en tant qu'invité, vous connecter ou créer un compte.",
        emailLabel: 'E-mail',
        continueBtn: 'Continuer',
        passwordLabel: 'Mot de Passe',
        logInBtn: 'Se Connecter',
        continueAsGuest: 'Continuer en tant qu\'Invité',
        createAccountInstead: 'Créer un compte à la place',
        confirmPasswordLabel: 'Confirmer le Mot de Passe',
        createAccountAndContinue: 'Créer un Compte et Continuer',
        errorEmailEmpty: 'Veuillez saisir votre e-mail.',
        errorEmailInvalid: 'Veuillez saisir une adresse e-mail valide.',
        errorWrongPassword: 'Mot de passe incorrect.',
        errorAccountNotFound: 'Compte introuvable.',
        errorPasswordWeak: 'Le mot de passe doit contenir au moins 8 caractères, dont une lettre et un chiffre.',
        errorPasswordMismatch: 'Les mots de passe ne correspondent pas.',
        errorAccountExists: 'Un compte avec cet e-mail existe déjà.',
        accountCreated: 'Votre compte a été créé.',
        errorNameRequired: 'Veuillez saisir votre prénom et votre nom.',
        errorNameFormat: 'Le prénom et le nom ne peuvent contenir que des lettres, espaces, tirets et apostrophes (50 caractères maximum chacun).',
        errorGeneric: "Une erreur s'est produite. Veuillez réessayer.",
        errorRateLimited: 'Trop de tentatives pour le moment. Veuillez patienter quelques minutes puis réessayer.',
        forgotPassword: 'Mot de passe oublié ?',
        resetPasswordSent: 'Un e-mail de réinitialisation du mot de passe a été envoyé à {email}.',
        resetPasswordError: "Impossible d'envoyer l'e-mail de réinitialisation. Veuillez vérifier l'adresse et réessayer.",
        confirmAccountPending: 'Consultez votre boîte de réception à {email} pour confirmer votre compte avant de vous connecter.',
        setNewPasswordHeading: 'Définir un Nouveau Mot de Passe',
        newPasswordLabel: 'Nouveau Mot de Passe',
        setNewPasswordBtn: 'Définir le Mot de Passe',
        phoneLabel: 'Numéro de Téléphone (facultatif)',
        marketingLabel: 'Je souhaite recevoir par e-mail les actualités produits, les promotions et la newsletter MONARK. Vous pouvez modifier ce choix à tout moment depuis votre page Compte &mdash; consultez notre <a href="confidentialite.html" target="_blank" rel="noopener">Politique de Confidentialité</a> pour en savoir plus.'
      },
      phoneInput: {
        countrySelectorLabel: 'Indicatif du pays',
        numberLabel: 'Numéro de téléphone',
        searchLabel: 'Rechercher un pays',
        searchPlaceholder: 'Rechercher un pays',
        noResults: 'Aucun pays trouvé',
        errorInvalidFR: 'Veuillez saisir un numéro de téléphone français valide (ex. 6 12 34 56 78).',
        errorInvalidGeneric: 'Veuillez saisir un numéro de téléphone valide.'
      },
      account: {
        pageTitle: 'Mon Compte',
        statusGuest: "Navigation en tant qu'invité ({email})",
        logOut: 'Se Déconnecter',
        orderHistoryHeading: 'Historique des Commandes',
        noOrdersYet: 'Aucune commande pour l\'instant — vos achats passés apparaîtront ici.',
        editProfileHeading: 'Modifier le Profil',
        emailLabel: 'E-mail',
        passwordLabel: 'Nouveau Mot de Passe',
        passwordHint: 'Laissez vide pour conserver votre mot de passe actuel.',
        firstNameLabel: 'Prénom',
        lastNameLabel: 'Nom',
        dobLabel: 'Date de Naissance',
        saveProfileBtn: 'Enregistrer les Modifications',
        profileUpdated: 'Profil mis à jour.',
        emailChangePending: 'Consultez votre nouvelle adresse e-mail pour confirmer le changement.',
        addressHeading: 'Adresse de Livraison Enregistrée',
        addressLabel: 'Adresse',
        addressLine2Label: "Bâtiment, étage, code d'accès…",
        cityLabel: 'Ville',
        postalCodeLabel: 'Code Postal',
        phoneLabel: 'Numéro de Téléphone',
        saveAddressBtn: "Enregistrer l'Adresse",
        addressUpdated: 'Adresse mise à jour.',
        paymentHeading: 'Carte Enregistrée',
        cardNameLabel: 'Nom sur la Carte',
        cardNumberLabel: 'Numéro de Carte',
        cardExpiryLabel: 'Expiration',
        paymentMockNote: 'Simulé à des fins de démonstration — aucune donnée de carte réelle n\'est stockée ni traitée.',
        savePaymentBtn: 'Enregistrer la Carte',
        paymentUpdated: 'Carte mise à jour.',
        preferencesHeading: 'Préférences',
        marketingLabel: 'Recevoir les e-mails marketing',
        savePreferencesBtn: 'Enregistrer les Modifications',
        preferencesUpdated: 'Préférences mises à jour.',
        orderDate: 'Commandé le {date}',
        orderQty: 'Qté {qty}',
        orderTotalLine: 'Total : {total}',
        guestOrderHistoryNote: 'Créez un compte pour consulter l\'historique de vos commandes et plus encore.',
        guestCreateAccountBtn: 'Créer un Compte',
        deleteAccountBtn: 'Supprimer le Compte',
        deleteConfirmText: 'Supprimer définitivement votre compte ?',
        deleteConfirmIrreversible: 'Cette action est irréversible.',
        deleteConfirmBtn: 'Confirmer la Suppression',
        deleteCancelBtn: 'Annuler'
      },
      faq: {
        pageTitle: 'Foire Aux Questions',
        intro: "Tout ce qu'il faut savoir avant, pendant et après l'acquisition de MONARK.",
        shipping: {
          heading: 'Expédition et Livraison',
          body: 'Les commandes sont actuellement expédiées sous 5 à 7 jours ouvrés, vers la France et la Belgique, la livraison étant toujours incluse dans le prix. Chaque flacon voyage dans son coffret d\'origine, enveloppé d\'un film plastique protecteur, conçu pour arriver exactement tel qu\'il nous a quitté.'
        },
        returns: {
          heading: 'Retours et Remboursements',
          body: 'Vous disposez de 14 jours à compter de la livraison pour retourner votre flacon MONARK et obtenir un remboursement intégral, à condition que l\'emballage plastique d\'origine soit encore intact, une fois ouvert, le flacon ne peut plus être retourné pour des raisons d\'hygiène, conformément au droit européen de la consommation. Les conditions complètes, y compris la marche à suivre pour un retour, figurent dans nos <a href="cgv.html">Conditions Générales de Vente</a>.'
        },
        ingredients: {
          heading: 'Ingrédients et Allergènes',
          body: 'La composition olfactive complète (notes de tête, de cœur et de fond) est détaillée sur la <a href="product.html">page produit</a>. Comme tout parfum de qualité, MONARK contient des composés aromatiques naturels et synthétiques susceptibles de provoquer des sensibilités chez certaines personnes, dont des allergènes de parfum courants réglementés par la législation cosmétique européenne (par exemple le linalol, le limonène). Si vous avez des sensibilités connues aux parfums, nous recommandons un test sur une petite zone de peau avant application complète.'
        },
        storage: {
          heading: 'Comment conserver mon flacon MONARK ?',
          body: "Conservez-le debout, à l'abri de la lumière directe et de la chaleur, idéalement dans un endroit à température stable, fraîche, un tiroir ou un placard convient mieux qu'une étagère de salle de bain ou un rebord de fenêtre. Ce sont la lumière et la chaleur qui altèrent réellement un parfum avec le temps, pas l'âge seul. Bien conservé, MONARK garde son caractère pendant des années."
        },
        promoCode: {
          heading: 'Comment utiliser un code promo ?',
          body: 'Saisissez votre code dans le champ Code Promo de la page de commande, puis sélectionnez « Appliquer », la réduction est calculée automatiquement et répercutée sur le total de votre commande avant que vous ne la validiez. Un seul code peut être appliqué par commande.'
        }
      },
      contact: {
        pageTitle: 'Contact',
        intro: 'Une question sur une commande, la composition, ou une demande de revente en gros, nous lisons chaque message personnellement.',
        reachUs: 'Contactez-nous directement à <span class="placeholder">[E-MAIL DE CONTACT — À COMPLÉTER]</span>, ou utilisez le formulaire ci-dessous.',
        whatsappBtn: 'Contactez-nous<br class="mobile-only-break"> sur WhatsApp',
        whatsappHref: "https://api.whatsapp.com/send?phone=33605893897&text=Bonjour%2C%20j%27ai%20une%20question.",
        honeypotLabel: 'Laissez ce champ vide',
        nameLabel: 'Nom',
        emailLabel: 'E-mail',
        reasonLabel: 'Motif',
        reasonPlaceholder: 'Sélectionner',
        reasonOrder: 'Question sur une commande',
        reasonWholesale: 'Revente en Gros',
        reasonPress: 'Presse',
        reasonOther: 'Autre',
        reasonError: 'Veuillez sélectionner un motif.',
        messageLabel: 'Message',
        submitBtn: 'Envoyer le Message',
        successMessage: "Merci — votre message a bien été reçu. Nous vous répondrons sous peu. (Ceci est une confirmation simulée ; aucun message n'a encore été réellement envoyé.)"
      },
      notFound: {
        heading: "Cette Pièce N'existe Pas",
        body: 'Certaines portes de cette maison ne mènent nulle part, volontairement. La page que vous cherchiez n\'a jamais été construite, ou elle a depuis disparu.<br>Rien ici sur quoi régner.',
        backToExperience: "Retour à L'Expérience",
        acquireMonark: 'Acquérir MONARK'
      },
      legalNotice: {
        pageTitle: 'Mentions Légales',
        publisherHeading: 'Éditeur du Site',
        publisherBody1: 'Le site Effluve Paris est édité par <span class="placeholder">[NOM DE LA SOCIÉTÉ — À COMPLÉTER]</span>, <span class="placeholder">[FORME JURIDIQUE — À COMPLÉTER]</span> au capital social de <span class="placeholder">[CAPITAL SOCIAL — À COMPLÉTER]</span>, immatriculée au Registre du Commerce et des Sociétés sous le numéro SIRET <span class="placeholder">[SIRET — À COMPLÉTER]</span>.',
        publisherBody2: 'Siège social : <span class="placeholder">[ADRESSE — À COMPLÉTER]</span><br>Numéro de TVA intracommunautaire : <span class="placeholder">[NUMÉRO DE TVA — À COMPLÉTER]</span>',
        directorHeading: 'Directeur de la Publication',
        directorBody: '<span class="placeholder">[NOM DU DIRECTEUR DE LA PUBLICATION — À COMPLÉTER]</span>',
        contactHeading: 'Contact',
        contactBody: 'Pour toute question relative au site ou aux présentes mentions légales, vous pouvez nous contacter à l\'adresse suivante : <a href="mailto:effluvepariscontact@gmail.com">effluvepariscontact@gmail.com</a>',
        hostingHeading: 'Hébergement',
        hostingBody: 'Cloudflare, Inc.',
        ipHeading: 'Propriété Intellectuelle',
        ipBody: 'Tous les éléments composant ce site (textes, images, logos, graphismes, vidéos) sont la propriété exclusive d\'Effluve Paris ou de ses partenaires, sauf mention contraire, et sont protégés par le droit de la propriété intellectuelle. Toute reproduction, représentation, modification ou utilisation, totale ou partielle, sans autorisation préalable, est interdite.',
        dataHeading: 'Données Personnelles',
        dataBody: 'Le traitement de vos données personnelles est décrit dans notre <a href="confidentialite.html">politique de confidentialité</a>.'
      },
      termsOfSale: {
        pageTitle: 'Conditions Générales de Vente',
        intro: "Les présentes Conditions Générales de Vente (les « Conditions ») régissent la vente des produits proposés sur le site Effluve Paris. Toute commande passée sur ce site implique l'acceptation sans réserve de ces Conditions par le client.",
        s1Heading: '1. Objet',
        s1Body: "Les présentes Conditions ont pour objet de définir les droits et obligations des parties dans le cadre de la vente en ligne des produits proposés par Effluve Paris, à savoir des parfums et produits dérivés.",
        s2Heading: '2. Prix',
        s2Body: 'Les prix des produits sont indiqués en euros (€), toutes taxes comprises. Effluve Paris se réserve le droit de modifier ses prix à tout moment, étant entendu que le prix affiché sur la commande au moment de sa confirmation par le client est le seul prix applicable à cette commande.',
        s3Heading: '3. Commande',
        s3Body: "Le client sélectionne les produits qu'il souhaite commander, les ajoute à son panier, puis confirme la commande après avoir vérifié le récapitulatif. La commande n'est définitive qu'une fois le paiement confirmé.",
        s4Heading: '4. Paiement',
        s4Body: 'Le paiement s\'effectue en ligne, au moment de la commande, par carte bancaire ou tout autre moyen de paiement proposé sur le site, via un prestataire de paiement sécurisé : Stripe.',
        s5Heading: '5. Livraison',
        s5Body1: 'Les produits sont livrés à l\'adresse indiquée par le client lors de la commande.',
        s5Body2: 'Zones de livraison : France et Belgique.<br>Délais de livraison estimés : 5 à 7 jours ouvrés.<br>Frais de livraison : la livraison est toujours offerte, incluse dans le prix du produit, et non une remise à partir d\'un certain seuil d\'achat.',
        s6Heading: '6. Droit de Rétractation',
        s6Body1: "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d'un délai de quatorze (14) jours francs à compter de la réception du produit pour exercer son droit de rétractation auprès d'Effluve Paris, sans avoir à justifier de motifs ni à payer de pénalités, à l'exception, le cas échéant, des frais de retour.",
        s6Body2: 'Pour exercer ce droit, le client doit notifier sa décision de rétractation au moyen d\'une déclaration dénuée d\'ambiguïté (courrier postal, e-mail, ou formulaire de rétractation) envoyée à <a href="mailto:effluvepariscontact@gmail.com">effluvepariscontact@gmail.com</a> avant l\'expiration du délai de 14 jours.',
        s6Body3: "Le client dispose ensuite d'un délai de quatorze (14) jours à compter de la communication de sa décision de rétractation pour retourner le produit. Effluve Paris remboursera l'intégralité des sommes versées, y compris les frais de livraison standard, au plus tard quatorze (14) jours après avoir été informé de la décision de rétractation, sauf si Effluve Paris propose de récupérer le bien lui-même ou si le client ne fournit pas de justificatif d'expédition, auquel cas le remboursement pourra être différé jusqu'à réception du bien ou jusqu'à ce que le client ait fourni une preuve de son expédition, la date retenue étant celle du premier de ces faits.",
        s6Body4: '<strong>Exception :</strong> conformément à l\'article L221-28 du Code de la consommation, le droit de rétractation ne peut être exercé pour les produits descellés par le client après la livraison et qui ne peuvent être renvoyés pour des raisons d\'hygiène ou de protection de la santé. Un flacon de parfum dont l\'emballage plastique d\'origine a été retiré ou dont le contenu a été ouvert ne peut donc faire l\'objet d\'un droit de rétractation, sauf en cas de non-conformité ou de défaut du produit.',
        s7Heading: '7. Retours et Remboursements',
        s7Body: "Les retours doivent être effectués dans leur emballage d'origine, non descellé, accompagnés d'un justificatif d'achat. Les frais de retour sont à la charge du client, sauf en cas de produit non conforme ou défectueux. Les remboursements sont effectués selon le même moyen de paiement que celui utilisé lors de la commande.",
        s8Heading: '8. Garanties',
        s8Body: 'Tous les produits vendus sur le site bénéficient de la garantie légale de conformité (articles L217-3 et suivants du Code de la consommation) et de la garantie légale des vices cachés (articles 1641 et suivants du Code civil).',
        s9Heading: '9. Litiges et Juridiction',
        s9Body: 'Les présentes Conditions sont soumises au droit français. En cas de litige, une solution amiable sera recherchée avant toute action judiciaire, notamment auprès du médiateur de la consommation <span class="placeholder">[MÉDIATEUR — À COMPLÉTER]</span>. À défaut d\'accord amiable, les tribunaux français seront seuls compétents.'
      },
      privacyPolicy: {
        pageTitle: 'Politique de Confidentialité',
        intro: 'Cette politique de confidentialité décrit la manière dont Effluve Paris collecte, utilise et protège les données personnelles des utilisateurs de ce site, conformément au Règlement Général sur la Protection des Données (RGPD | Règlement (UE) 2016/679) et à la Loi Informatique et Libertés.',
        s1Heading: '1. Données Collectées',
        s1Intro: 'Dans le cadre de votre navigation et de vos commandes sur le site, nous sommes susceptibles de collecter les données suivantes :',
        s1Item1: 'Identité : nom et prénom',
        s1Item2: 'Coordonnées : adresse e-mail, adresse postale, numéro de téléphone',
        s1Item3: "Données de commande : historique d'achats, produits consultés",
        s1Item4: "Données de paiement : traitées directement par notre prestataire de paiement ; Effluve Paris n'a pas accès aux coordonnées bancaires complètes",
        s1Item5: 'Données de navigation : adresse IP, cookies (voir section 8)',
        s2Heading: '2. Finalités du Traitement',
        s2Body: 'Ces données sont collectées pour les finalités suivantes : traitement et suivi des commandes, gestion de la relation client, prévention de la fraude, amélioration du site et de l\'expérience utilisateur, et, sous réserve de votre consentement, envoi de communications marketing.',
        s3Heading: '3. Base Légale du Traitement',
        s3Body: 'Le traitement de vos données repose, selon les cas, sur : l\'exécution du contrat de vente (pour le traitement des commandes), le consentement (pour la newsletter et les cookies non essentiels), l\'intérêt légitime d\'Effluve Paris (amélioration du service, sécurité), et le respect d\'obligations légales (facturation, comptabilité).',
        s4Heading: '4. Durée de Conservation des Données',
        s4Body: 'Vos données sont conservées pendant la durée nécessaire à la réalisation des finalités pour lesquelles elles ont été collectées, et notamment : les données liées aux commandes sont conservées pendant la durée imposée par les obligations comptables et fiscales (10 ans) ; les données prospects sont conservées 3 ans à compter du dernier contact.',
        s5Heading: '5. Vos Droits',
        s5Intro: 'Conformément aux articles 15 à 22 du RGPD, vous disposez des droits suivants sur vos données personnelles :',
        s5Right1: '<strong>Droit d\'accès</strong> : obtenir la confirmation que vos données sont traitées et en obtenir une copie ;',
        s5Right2: '<strong>Droit de rectification</strong> : faire corriger des données inexactes ou incomplètes ;',
        s5Right3: '<strong>Droit à l\'effacement</strong> (« droit à l\'oubli ») : demander la suppression de vos données, dans les conditions prévues par le RGPD ;',
        s5Right4: '<strong>Droit à la limitation du traitement</strong> ;',
        s5Right5: '<strong>Droit à la portabilité des données</strong> : recevoir vos données dans un format structuré, couramment utilisé et lisible par machine, et les transmettre à un autre responsable de traitement ;',
        s5Right6: '<strong>Droit d\'opposition</strong>, notamment au traitement à des fins de prospection ;',
        s5Right7: '<strong>Droit de retirer votre consentement</strong> à tout moment, lorsque le traitement est fondé sur celui-ci.',
        s5Cnil: 'Vous disposez également du droit d\'introduire une réclamation auprès de la Commission Nationale de l\'Informatique et des Libertés (CNIL) si vous estimez que le traitement de vos données personnelles constitue une violation du RGPD.',
        s6Heading: '6. Destinataires et Tiers',
        s6Body: 'Vos données peuvent être communiquées aux destinataires suivants, strictement limités à leurs besoins respectifs : notre prestataire de paiement pour le traitement des transactions (Stripe), notre hébergeur (Cloudflare, Inc.), et nos prestataires de livraison. Ces tiers sont tenus de respecter la confidentialité et la sécurité de vos données.',
        transfersHeading: '7. Transferts Internationaux de Données',
        transfersIntro: "Dans le cadre de l'utilisation de nos prestataires techniques, certaines données peuvent être traitées en dehors de l'Union Européenne :",
        transfersItem1: 'Hébergement (Cloudflare, Inc.) : société basée aux États-Unis, opérant un réseau mondial de serveurs.',
        transfersItem2: "Base de données (Supabase Pte. Ltd.) : société basée à Singapour ; nos données sont hébergées et principalement traitées en Irlande (UE), mais Supabase fait appel à des sous-traitants basés aux États-Unis (dont Amazon Web Services, Google, Cloudflare) pour ses services d'hébergement et de support.",
        transfersItem3: "Paiement (Stripe, LLC / Stripe Payments Europe Limited) : société basée aux États-Unis, avec une filiale européenne (Irlande) ; certaines données transitent par des sous-traitants américains (Twilio, Google, Salesforce) dans le cadre du traitement des paiements et du support technique.",
        transfersItem4: 'Polices de caractères (Google Fonts) : société basée aux États-Unis.',
        transfersSafeguards: 'Ces transferts sont encadrés par les Clauses Contractuelles Types de la Commission européenne, garantissant un niveau de protection adéquat pour vos données personnelles.',
        s7Heading: '8. Cookies',
        s7Body: 'Ce site utilise des cookies pour améliorer votre expérience de navigation, mesurer l\'audience du site et, sous réserve de votre consentement, à des fins de personnalisation. Vous pouvez accepter ou refuser les cookies non essentiels via la bannière de consentement affichée lors de votre première visite. Vous pouvez également modifier vos préférences à tout moment en supprimant les données de navigation stockées par votre navigateur pour ce site.',
        s8Heading: '9. Contact',
        s8Body: 'Pour toute question relative à vos données personnelles ou pour exercer vos droits, vous pouvez contacter notre Délégué à la Protection des Données (DPO) à l\'adresse suivante : <a href="mailto:effluvepariscontact@gmail.com">effluvepariscontact@gmail.com</a>'
      }
    }
  };

  function resolveKey(dict, key) {
    return key.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), dict);
  }

  function getLang() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'en' || stored === 'fr' ? stored : DEFAULT_LANG;
  }

  // {name} placeholder substitution — used by callers that need a dynamic
  // value (item count, promo code, captured email) inside an otherwise
  // translated string, since those values can't live in the static dictionary.
  function t(key, vars) {
    const lang = getLang();
    let str = resolveKey(TRANSLATIONS[lang], key);
    if (str === undefined) str = resolveKey(TRANSLATIONS[DEFAULT_LANG], key);
    if (str === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach((k) => {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return str;
  }

  // root defaults to the whole document — pass a detached/just-inserted
  // container when a widget script builds its own markup at runtime, so the
  // pass doesn't have to wait for (or re-walk) the entire page.
  function apply(root) {
    const scope = root || document;
    const lang = getLang();
    const dict = TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG];

    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const val = resolveKey(dict, el.getAttribute('data-i18n'));
      if (val !== undefined) el.textContent = val;
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const val = resolveKey(dict, el.getAttribute('data-i18n-html'));
      if (val !== undefined) el.innerHTML = val;
    });
    // data-i18n-attr="aria-label:navMenu.openMenu;title:foo.bar" — semicolon-
    // separated attr:key pairs, for attributes rather than element content.
    scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s && s.trim());
        if (!attr || !key) return;
        const val = resolveKey(dict, key);
        if (val !== undefined) el.setAttribute(attr, val);
      });
    });
  }

  function setLang(lang) {
    if (lang !== 'en' && lang !== 'fr') return;
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    apply(document);
    document.dispatchEvent(new CustomEvent('monark:langchange', { detail: { lang } }));
  }

  document.documentElement.lang = getLang();
  apply(document);

  window.MonarkI18n = { getLang, setLang, t, apply, DEFAULT_LANG, STORAGE_KEY };
})();
