/* Effluve Paris — admin.html's own script. Self-contained (doesn't load
   js/account.js) -- this page needs a narrow slice of Supabase Auth (get the
   current session, sign out) plus its own admin-only queries, not
   js/account.js's whole customer-account surface (mocked card fields,
   guest-checkout GUEST_KEY, password reset, etc., none of which apply here).

   AUTH: the check below (real session + profiles.is_admin === true) is only
   ever a UX convenience -- it decides whether this tab SHOWS the admin UI,
   nothing more. The actual security boundary is server-side RLS (see
   supabase/migrations/20260806000000_admin_shipping.sql): a non-admin whose
   browser somehow reached this page and called the same update() below
   would still get a Postgres permission error, because the policy (not this
   file) is what Postgres actually enforces. Never assume this file is the
   only thing standing between a non-admin and the data. */
(function () {
  function client() { return window.MonarkSupabase; }

  const authGate = document.getElementById('admin-auth-gate');
  const app = document.getElementById('admin-app');
  const whoamiEl = document.getElementById('admin-whoami');

  function redirectToLogin() {
    window.location.href = 'account.html';
  }

  async function checkAccessAndInit() {
    if (!client() || !client().auth) {
      authGate.textContent = 'Erreur de configuration -- réessayez plus tard.';
      return;
    }

    // getSession() (not a synchronous cache like js/account.js's own
    // getSession() -- see that file's own comment on why IT can get away
    // with a cache) -- this is a security gate, so it needs the real,
    // resolved answer, not an optimistic value that might flip a moment
    // later.
    const { data: { session } } = await client().auth.getSession();
    if (!session) {
      redirectToLogin();
      return;
    }

    const { data: profile, error } = await client()
      .from('profiles')
      .select('is_admin, first_name, last_name')
      .eq('id', session.user.id)
      .single();

    if (error || !profile || profile.is_admin !== true) {
      redirectToLogin();
      return;
    }

    authGate.hidden = true;
    app.hidden = false;
    const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
    whoamiEl.textContent = name ? `${name} (${session.user.email})` : session.user.email;

    initTabs();
    initLogout();
    initOrders();
  }

  // ---------------- Tabs (generic -- see admin.html's own comment) ----------------
  function initTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    const panels = document.querySelectorAll('.admin-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        const target = tab.getAttribute('data-tab');
        panels.forEach((panel) => {
          panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === target);
        });
      });
    });
  }

  function initLogout() {
    document.getElementById('admin-logout').addEventListener('click', async () => {
      await client().auth.signOut();
      redirectToLogin();
    });
  }

  // ---------------- Orders tab ----------------
  let ordersCache = []; // last successful fetch, re-rendered on filter toggle without a refetch
  let profileNameById = {}; // user_id -> "First Last" (or "" if never set)

  const loadingEl = document.getElementById('admin-orders-loading');
  const errorEl = document.getElementById('admin-orders-error');
  const emptyEl = document.getElementById('admin-orders-empty');
  const tableEl = document.getElementById('admin-orders-table');
  const tbodyEl = document.getElementById('admin-orders-tbody');
  const filterPendingEl = document.getElementById('admin-filter-pending');

  function initOrders() {
    filterPendingEl.addEventListener('change', () => renderOrders());
    loadOrders();
  }

  async function loadOrders() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    emptyEl.hidden = true;
    tableEl.hidden = true;

    // status = 'paid' only -- an order still 'processing' (webhook hasn't
    // reconciled it yet, see supabase/functions/stripe-webhook's own
    // comment) was never actually confirmed as paid, so there's nothing to
    // ship yet regardless of what shipping_status defaults to.
    const { data: orders, error: ordersError } = await client()
      .from('orders')
      .select('id, reference_number, user_id, guest_email, product_name, quantity, total, created_at, shipping_status, tracking_number')
      .eq('status', 'paid')
      .order('created_at', { ascending: false });

    if (ordersError) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = `Erreur lors du chargement des commandes : ${ordersError.message}`;
      console.error('admin.js loadOrders:', ordersError.message);
      return;
    }

    // Two separate queries (orders, then profiles for the user_ids present)
    // rather than a PostgREST embed -- orders.user_id's own foreign key
    // points at auth.users, not public.profiles (no direct FK PostgREST
    // could auto-detect a relationship from), so a manual client-side join
    // is the straightforward option here.
    const userIds = Array.from(new Set(orders.filter((o) => o.user_id).map((o) => o.user_id)));
    profileNameById = {};
    if (userIds.length) {
      const { data: profiles, error: profilesError } = await client()
        .from('profiles')
        .select('id, first_name, last_name')
        .in('id', userIds);
      if (profilesError) {
        console.error('admin.js loadOrders (profiles):', profilesError.message);
        // Not fatal -- orders still render, just with a blank customer name
        // for whichever rows needed a profile lookup that failed.
      } else {
        profiles.forEach((p) => {
          profileNameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(' ');
        });
      }
    }

    ordersCache = orders;
    loadingEl.hidden = true;
    renderOrders();
  }

  function customerLabel(order) {
    if (order.user_id) return profileNameById[order.user_id] || '(compte sans nom)';
    if (order.guest_email) return order.guest_email;
    return '—';
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('fr-FR', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatMoney(n) {
    return '€' + Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderOrders() {
    const showPendingOnly = filterPendingEl.checked;
    const rows = showPendingOnly
      ? ordersCache.filter((o) => o.shipping_status !== 'shipped')
      : ordersCache;

    if (!rows.length) {
      tableEl.hidden = true;
      emptyEl.hidden = false;
      tbodyEl.innerHTML = '';
      return;
    }

    emptyEl.hidden = true;
    tableEl.hidden = false;
    tbodyEl.innerHTML = rows.map((order) => {
      const shipped = order.shipping_status === 'shipped';
      return `
        <tr class="${shipped ? 'admin-order-row-shipped' : ''}" data-order-id="${order.id}">
          <td data-label="Référence">${escapeHtml(order.reference_number || '—')}</td>
          <td data-label="Client">${escapeHtml(customerLabel(order))}</td>
          <td data-label="Produit">${escapeHtml(order.product_name)} × ${order.quantity} (${formatMoney(order.total)})</td>
          <td data-label="Date">${formatDate(order.created_at)}</td>
          <td data-label="Statut"><span class="admin-status-pill ${shipped ? 'admin-status-shipped' : 'admin-status-pending'}">${shipped ? 'Expédiée' : 'En attente'}</span></td>
          <td data-label="Suivi">${order.tracking_number ? `<span class="admin-tracking-value">${escapeHtml(order.tracking_number)}</span>` : '—'}</td>
          <td data-label="">${shipped ? '' : `<button type="button" class="admin-ship-btn" data-ship-order-id="${order.id}">Marquer comme expédié</button>`}</td>
        </tr>
      `;
    }).join('');

    tbodyEl.querySelectorAll('[data-ship-order-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const order = ordersCache.find((o) => o.id === btn.getAttribute('data-ship-order-id'));
        if (order) openShipModal(order);
      });
    });
  }

  // ---------------- Mark-as-shipped modal ----------------
  const modal = document.getElementById('admin-ship-modal');
  const modalRefEl = document.getElementById('admin-ship-modal-ref');
  const modalErrorEl = document.getElementById('admin-ship-modal-error');
  const trackingInput = document.getElementById('admin-tracking-input');
  const shipConfirmBtn = document.getElementById('admin-ship-confirm');
  const shipCancelBtn = document.getElementById('admin-ship-cancel');

  let orderBeingShipped = null;

  function openShipModal(order) {
    orderBeingShipped = order;
    modalRefEl.textContent = `Commande ${order.reference_number || order.id}`;
    trackingInput.value = '';
    modalErrorEl.textContent = '';
    modal.hidden = false;
    trackingInput.focus();
  }

  function closeShipModal() {
    modal.hidden = true;
    orderBeingShipped = null;
  }

  shipCancelBtn.addEventListener('click', closeShipModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeShipModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeShipModal();
  });

  shipConfirmBtn.addEventListener('click', async () => {
    const trackingNumber = trackingInput.value.trim();
    if (!trackingNumber) {
      modalErrorEl.textContent = 'Merci de renseigner un numéro de suivi.';
      trackingInput.focus();
      return;
    }
    if (!orderBeingShipped) return;

    shipConfirmBtn.disabled = true;
    modalErrorEl.textContent = '';

    // RLS-gated update via the admin's own session (see this file's own
    // top-of-file comment) -- not a service-role/Edge Function call. The
    // column-scoped GRANT (shipping_status, tracking_number only) plus the
    // "Admins can update shipping fields" policy are what actually make
    // this succeed only for an is_admin account.
    const { error } = await client()
      .from('orders')
      .update({ shipping_status: 'shipped', tracking_number: trackingNumber })
      .eq('id', orderBeingShipped.id);

    shipConfirmBtn.disabled = false;

    if (error) {
      modalErrorEl.textContent = `Échec de la mise à jour : ${error.message}`;
      console.error('admin.js ship update:', error.message);
      return;
    }

    closeShipModal();
    loadOrders();
  });

  checkAccessAndInit();
})();
