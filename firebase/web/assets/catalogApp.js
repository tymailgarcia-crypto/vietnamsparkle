import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  setDoc,
  updateDoc
} from "./firebaseClient.js";
import {
  escapeHtml,
  formatCurrency,
  productCategoryKey,
  productImageUrl,
  requireRole,
  slugify,
  withSubmitLock
} from "./shared.js";
import { uploadProductImage, validateProofFile } from "./storageUploads.js";

// Product builder (Ty, 2026-07-17). Owner CRUD over /products — until this
// page, the only writers were the Sheets import script and the Firestore
// console, so a price change needed a developer. Rules already allow
// `write: if isOwner()`; nothing here needed a rules change.
//
// Two invariants the UI enforces on purpose:
//   - Products are retired (active: false), never deleted — orderItems
//     reference them and history must keep resolving.
//   - containerType comes from a fixed select, because it keys the deposit
//     ledger (computeDepositBreakdown) and free text would corrupt it.
//
// Price edits are safe by design: submitPublicOrder re-prices server-side at
// order time and past orders store their own totals.

const state = {
  products: [],
  layout: "cards"
};

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function sortedProducts(list) {
  return [...list].sort((a, b) => (Number(a.sortOrder ?? 9999) - Number(b.sortOrder ?? 9999))
    || String(a.productName || "").localeCompare(String(b.productName || "")));
}

const CATEGORY_LABELS = { glass: "Glass bottle water", jug: "Large water jugs", addon: "Extra items" };
const CONTAINER_LABELS = {
  "": "not returnable",
  glass_crate: "glass crate",
  "18_9l_jug": "18.9 L jug",
  "19l_jug": "19 L jug",
  "20l_jug": "20 L jug",
  mixed: "mixed containers"
};

function renderProductCard(product) {
  const img = productImageUrl(product);
  const thumb = img
    ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<span class="muted" style="font-size:11px">no image</span>`;
  const container = CONTAINER_LABELS[String(product.containerType || "")] ?? String(product.containerType);
  const deposit = Number(product.defaultDepositAmount || 0);
  return `
    <article class="catalog-admin-item${product.active === true ? "" : " is-retired"}">
      <div class="catalog-admin-thumb">${thumb}</div>
      <div class="catalog-admin-body">
        <div class="catalog-admin-head">
          <strong>${escapeHtml(product.productName || product.id)}</strong>
          <code>${escapeHtml(product.id)}</code>
        </div>
        <div class="muted catalog-admin-meta">
          ${escapeHtml(formatCurrency(product.unitPrice))}${product.unitLabel ? ` ${escapeHtml(product.unitLabel)}` : ""}
          · ${CATEGORY_LABELS[productCategoryKey(product)]}
          · ${deposit > 0 ? `${escapeHtml(formatCurrency(deposit))} deposit (${escapeHtml(container)})` : "no deposit"}
          ${product.notes ? ` · ${escapeHtml(product.notes)}` : ""}
        </div>
      </div>
      <div class="button-row catalog-admin-actions">
        <button class="secondary" type="button" data-edit="${escapeHtml(product.id)}">Edit</button>
        ${product.active === true
          ? `<button class="ghost" type="button" data-retire="${escapeHtml(product.id)}">Retire</button>`
          : `<button class="primary" type="button" data-restore="${escapeHtml(product.id)}">Put back on sale</button>`}
      </div>
    </article>
  `;
}

function renderProducts() {
  const active = sortedProducts(state.products.filter((p) => p.active === true));
  const retired = sortedProducts(state.products.filter((p) => p.active !== true));
  el("product-list").innerHTML = active.length
    ? active.map(renderProductCard).join("")
    : `<p class="muted" style="padding:14px;text-align:center">No products on sale. Add the first one.</p>`;
  el("retired-list").innerHTML = retired.length
    ? retired.map(renderProductCard).join("")
    : `<p class="muted" style="padding:8px 0">Nothing retired.</p>`;
  el("retired-count").textContent = String(retired.length);
  setStatus(`${active.length} on sale · ${retired.length} retired`);

  document.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openProductDialog(state.products.find((p) => p.id === btn.dataset.edit)));
  });
  document.querySelectorAll("[data-retire]").forEach((btn) => {
    btn.addEventListener("click", () => setActive(btn.dataset.retire, false, btn));
  });
  document.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.addEventListener("click", () => setActive(btn.dataset.restore, true, btn));
  });
}

async function setActive(productId, active, button) {
  await withSubmitLock(button, async () => {
    try {
      await updateDoc(doc(db, "products", productId), {
        active,
        updatedAt: new Date().toISOString()
      });
      const product = state.products.find((p) => p.id === productId);
      if (product) product.active = active;
    } catch (error) {
      setStatus(`Could not update ${productId}: ${error.message || error}`);
    }
  });
  renderProducts();
}

// --- Add / edit dialog ------------------------------------------------------

function updateImagePreview() {
  const url = el("product-image-url").value.trim();
  const name = el("product-name").value.trim();
  const effective = url || productImageUrl(name);
  const wrap = el("product-image-preview");
  if (!effective) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  el("product-image-preview-img").src = effective;
  el("product-image-preview-note").textContent = url
    ? "Custom image."
    : "Automatic photo match on the name — set a URL to override.";
}

// Photo upload: runs immediately on file pick and drops the tokenized
// download URL into the Image URL field, so "Save product" persists it like
// any hand-typed URL. For a NOT-yet-saved product the id is derived from the
// name (it's deterministic, P-<slug>), so the blob files under the right
// prefix without a save-first dance. If the owner renames before saving, the
// blob path keeps the old slug — cosmetic only, the token URL is what's
// stored and it never depends on the final doc id.
async function handleImageFilePick(event) {
  const input = event.currentTarget;
  const hint = el("product-image-file-hint");
  const file = input.files && input.files[0];
  if (!file) return;
  const problem = validateProofFile(file);
  if (problem) {
    hint.textContent = problem;
    hint.style.color = "var(--danger, #b3261e)";
    input.value = "";
    return;
  }
  const productId = el("product-id").value.trim()
    || (slugify(el("product-name").value) ? `P-${slugify(el("product-name").value).toUpperCase()}` : "");
  if (!productId) {
    hint.textContent = "Type the product name first, then pick the photo.";
    hint.style.color = "var(--danger, #b3261e)";
    input.value = "";
    return;
  }
  try {
    hint.style.color = "";
    hint.textContent = "Uploading…";
    input.disabled = true;
    const { downloadUrl } = await uploadProductImage({ productId, file });
    el("product-image-url").value = downloadUrl;
    updateImagePreview();
    hint.textContent = "Uploaded — the URL above now points at your photo. Save to keep it.";
  } catch (error) {
    hint.textContent = `Upload failed: ${error.message || error}`;
    hint.style.color = "var(--danger, #b3261e)";
  } finally {
    input.disabled = false;
    input.value = "";
  }
}

function openProductDialog(product) {
  const isEdit = !!product;
  el("product-dialog-title").textContent = isEdit ? `Edit — ${product.productName || product.id}` : "Add product";
  el("product-id").value = isEdit ? product.id : "";
  el("product-name").value = isEdit ? (product.productName || "") : "";
  el("product-price").value = isEdit ? Number(product.unitPrice || 0) : "";
  el("product-deposit").value = isEdit ? Number(product.defaultDepositAmount || 0) : 0;
  el("product-category").value = isEdit ? productCategoryKey(product) : "jug";
  el("product-container-type").value = isEdit ? String(product.containerType || "") : "";
  el("product-unit-label").value = isEdit ? (product.unitLabel || "") : "";
  el("product-sort").value = isEdit && product.sortOrder != null ? Number(product.sortOrder) : "";
  el("product-image-url").value = isEdit ? (product.imageUrl || "") : "";
  el("product-notes").value = isEdit ? (product.notes || "") : "";
  const statusNode = el("product-status");
  statusNode.textContent = "";
  statusNode.style.color = "";
  const fileInput = el("product-image-file");
  if (fileInput) fileInput.value = "";
  const fileHint = el("product-image-file-hint");
  if (fileHint) {
    fileHint.textContent = "Uploads immediately and fills the URL above. Max 10 MB.";
    fileHint.style.color = "";
  }
  updateImagePreview();
  el("product-dialog").showModal();
}

async function saveProduct(event) {
  event.preventDefault();
  const statusNode = el("product-status");
  const existingId = el("product-id").value.trim();
  const name = el("product-name").value.trim();
  const price = Number(el("product-price").value);
  const deposit = Number(el("product-deposit").value || 0);
  if (!name || !Number.isFinite(price) || price < 0 || deposit < 0) {
    statusNode.textContent = "Name and a non-negative price are required.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  const containerType = el("product-container-type").value;
  if (deposit > 0 && !containerType) {
    statusNode.textContent = "A deposit needs a returnable container type — pick one, or set the deposit to 0.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  const sortRaw = el("product-sort").value;
  const payload = {
    productName: name,
    category: el("product-category").value,
    containerType: containerType || null,
    unitLabel: el("product-unit-label").value.trim() || null,
    unitPrice: price,
    defaultDepositAmount: deposit,
    imageUrl: el("product-image-url").value.trim() || null,
    notes: el("product-notes").value.trim() || null,
    sortOrder: sortRaw === "" ? null : Number(sortRaw),
    updatedAt: new Date().toISOString()
  };

  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving…";
      statusNode.style.color = "";
      let id = existingId;
      if (!id) {
        id = `P-${slugify(name).toUpperCase()}`;
        if (!slugify(name)) throw new Error("Could not build a product id from that name.");
        const clash = await getDoc(doc(db, "products", id));
        if (clash.exists()) {
          throw new Error(`A product with id ${id} already exists — edit that one, or vary the name.`);
        }
        payload.active = true;
        payload.createdAt = payload.updatedAt;
      }
      await setDoc(doc(db, "products", id), payload, { merge: true });
      el("product-dialog").close();
      await loadProducts();
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

// --- Customer storefront layout ---------------------------------------------

function renderLayoutButtons() {
  el("layout-cards-button").setAttribute("aria-pressed", String(state.layout === "cards"));
  el("layout-list-button").setAttribute("aria-pressed", String(state.layout === "list"));
  el("layout-cards-button").classList.toggle("catalog-layout-active", state.layout === "cards");
  el("layout-list-button").classList.toggle("catalog-layout-active", state.layout === "list");
}

async function setLayout(layout, button) {
  const statusNode = el("layout-status");
  await withSubmitLock(button, async () => {
    try {
      statusNode.textContent = "Saving…";
      await setDoc(doc(db, "settings", "business"), {
        catalogLayout: layout,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      state.layout = layout;
      statusNode.textContent = `Customers now see the ${layout} layout.`;
    } catch (error) {
      statusNode.textContent = `Could not save: ${error.message || error}`;
    }
  });
  renderLayoutButtons();
}

// --- Loading -----------------------------------------------------------------

async function loadProducts() {
  setStatus("Loading products…");
  try {
    const snap = await getDocs(collection(db, "products"));
    state.products = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    renderProducts();
  } catch (error) {
    setStatus(`Could not load products: ${error.message || error}`);
  }
}

async function loadLayout() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
    state.layout = settings.catalogLayout === "list" ? "list" : "cards";
  } catch (_) {
    state.layout = "cards";
  }
  renderLayoutButtons();
}

el("add-product-button").addEventListener("click", () => openProductDialog(null));
el("refresh-button").addEventListener("click", loadProducts);
el("product-form").addEventListener("submit", saveProduct);
el("product-cancel-button").addEventListener("click", () => el("product-dialog").close());
el("product-image-url").addEventListener("input", updateImagePreview);
el("product-image-file").addEventListener("change", handleImageFilePick);
el("product-name").addEventListener("input", updateImagePreview);
el("layout-cards-button").addEventListener("click", (e) => setLayout("cards", e.currentTarget));
el("layout-list-button").addEventListener("click", (e) => setLayout("list", e.currentTarget));

onAuthStateChanged(auth, async (user) => {
  const authView = el("auth-view");
  const appView = el("app-view");
  if (!user) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) return;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await Promise.all([loadProducts(), loadLayout()]);
});
