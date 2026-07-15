// Invoice generator — HTML preview + downloadable PDF for a single order.
// Third-party libs (jsPDF, qrcode) load on demand from esm.run so the rest of
// the app pays zero cost until the owner opens the invoice dialog.
import { todayKey } from "./shared.js";

function formatVnd(amount) {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(amount || 0))) + " VND";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// VietQR uses the EMVCo QR spec. Each field is TLV: 2-char id + 2-char length
// + value. Amount is field 54, reference is nested in field 62.08. CRC is
// CRC-16/CCITT-FALSE over the payload including the trailing "6304" marker.
function tlv(id, value) {
  const v = String(value == null ? "" : value);
  return id + String(v.length).padStart(2, "0") + v;
}

function crc16Ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i += 1) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function buildVietQrPayload({ bin, accountNumber, amount, reference, accountName }) {
  if (!bin || !accountNumber) return null;
  const merchantAccount =
    tlv("00", "A000000727") +
    tlv("01", tlv("00", String(bin)) + tlv("01", String(accountNumber))) +
    tlv("02", "QRIBFTTA");

  const additional = tlv("08", (reference || "").slice(0, 25));

  let payload =
    tlv("00", "01") +
    tlv("01", "12") +
    tlv("38", merchantAccount) +
    tlv("53", "704");
  if (amount != null && amount > 0) {
    payload += tlv("54", String(Math.round(amount)));
  }
  payload += tlv("58", "VN");
  if (accountName) {
    payload += tlv("59", String(accountName).slice(0, 25));
  }
  payload += tlv("62", additional);
  payload += "6304";
  return payload + crc16Ccitt(payload);
}

async function loadQrCode() {
  const mod = await import("https://esm.run/qrcode@1.5.4");
  return mod.default || mod;
}

async function loadJsPdf() {
  const mod = await import("https://esm.run/jspdf@2.5.1");
  return mod.jsPDF || (mod.default && mod.default.jsPDF) || mod.default;
}

export async function renderQrDataUrl(payload) {
  if (!payload) return null;
  const QRCode = await loadQrCode();
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
    color: { dark: "#0b7a63", light: "#ffffff" }
  });
}

export function invoiceContext({ order, items, settings }) {
  const business = settings || {};
  const bank = business.bank || {};
  const contact = business.contact || {};

  const balanceDue = Math.max(0, Number(order.balanceDue || 0));
  const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);

  const qrPayload = balanceDue > 0
    ? buildVietQrPayload({
        bin: bank.bin,
        accountNumber: bank.accountNumber,
        accountName: bank.accountName,
        amount: balanceDue,
        reference: order.id
      })
    : null;

  const isDraft = order.status !== "delivered";
  const invoiceTitle = isDraft ? "Order confirmation" : "Invoice";
  const invoiceNumber = order.id;
  const issuedDate = todayKey();

  return {
    business,
    bank,
    contact,
    order,
    items: items || [],
    balanceDue,
    total,
    qrPayload,
    isDraft,
    invoiceTitle,
    invoiceNumber,
    issuedDate
  };
}

export function renderInvoiceHtml(ctx) {
  const b = ctx.business || {};
  const bank = ctx.bank || {};
  const order = ctx.order || {};
  const items = ctx.items || [];

  const businessBlock = `
    <div style="font-size:13px;line-height:1.4">
      <div style="font-size:16px;font-weight:700">${escapeHtml(b.businessName || b.legalName || "Vietnam Sparkle")}</div>
      ${b.legalName && b.legalName !== b.businessName ? `<div>${escapeHtml(b.legalName)}</div>` : ""}
      ${b.taxCode ? `<div>Tax code: ${escapeHtml(b.taxCode)}</div>` : ""}
      ${b.registeredAddress ? `<div>${escapeHtml(b.registeredAddress)}</div>` : ""}
    </div>
  `;

  const customerBlock = `
    <div style="font-size:13px;line-height:1.4">
      <div style="font-weight:600">Deliver to</div>
      <div>${escapeHtml(order.customerName || "")}</div>
      ${order.phone ? `<div>${escapeHtml(order.phone)}</div>` : ""}
      ${order.address ? `<div>${escapeHtml(order.address)}</div>` : ""}
      ${order.deliveryDate ? `<div>Delivery: ${escapeHtml(order.deliveryDate)}${order.deliveryWindow ? " · " + escapeHtml(order.deliveryWindow) : ""}</div>` : ""}
    </div>
  `;

  const itemRows = items.length
    ? items.map((item) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(item.productName || item.productId || "")}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${Number(item.quantity || 0)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${escapeHtml(formatVnd(item.unitPrice))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${escapeHtml(formatVnd(item.lineTotal || (Number(item.unitPrice || 0) * Number(item.quantity || 0))))}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="4" style="padding:12px;text-align:center;color:#888">No line items on file for this order.</td></tr>`;

  const bankBlock = bank.accountNumber
    ? `
      <div style="font-size:12px;line-height:1.5">
        <div style="font-weight:600">Bank transfer</div>
        <div>${escapeHtml(bank.name || "")}</div>
        <div>${escapeHtml(bank.accountName || "")}</div>
        <div style="font-family:monospace">${escapeHtml(bank.accountNumber)}</div>
        <div>Reference: <strong>${escapeHtml(order.id)}</strong></div>
      </div>
    `
    : `<div style="font-size:12px;color:#888">Bank details not configured in settings.</div>`;

  const qrBlock = ctx.qrPayload
    ? `<div id="invoice-qr-slot" style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;color:#888;font-size:12px">Loading QR…</div>`
    : (ctx.balanceDue > 0
        ? `<div style="width:200px;font-size:12px;color:#888">Add bank BIN + account number in Settings to enable a scan-to-pay QR.</div>`
        : `<div style="width:200px;font-size:12px;color:#0b7a63;font-weight:600">Paid in full</div>`);

  return `
    <div id="invoice-preview" style="font-family:system-ui,-apple-system,sans-serif;color:#142631;padding:24px;background:#fff;max-width:720px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;border-bottom:2px solid #0b7a63;padding-bottom:16px">
        <div>
          <div style="font-size:24px;font-weight:700;color:#0b7a63">${escapeHtml(ctx.invoiceTitle)}</div>
          <div style="color:#5d6a74;font-size:13px">${ctx.isDraft ? "Preview / not yet finalized" : "Delivered and issued"}</div>
        </div>
        <div style="text-align:right;font-size:12px;line-height:1.6">
          <div><strong>No.</strong> ${escapeHtml(ctx.invoiceNumber)}</div>
          <div>Issued: ${escapeHtml(ctx.issuedDate)}</div>
          ${order.deliveryDate ? `<div>Delivery: ${escapeHtml(order.deliveryDate)}</div>` : ""}
          <div>Status: ${escapeHtml(order.status || "unknown")}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px">
        ${businessBlock}
        ${customerBlock}
      </div>

      <table style="width:100%;border-collapse:collapse;margin-top:20px;font-size:13px">
        <thead>
          <tr style="background:rgba(11,122,99,0.08)">
            <th style="padding:8px;text-align:left">Item</th>
            <th style="padding:8px;text-align:right;width:60px">Qty</th>
            <th style="padding:8px;text-align:right;width:120px">Unit price</th>
            <th style="padding:8px;text-align:right;width:120px">Line total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px;font-size:13px">
        <div style="color:#5d6a74;text-align:right">Subtotal</div>
        <div style="text-align:right">${escapeHtml(formatVnd(order.subtotal))}</div>
        <div style="color:#5d6a74;text-align:right">Container deposit</div>
        <div style="text-align:right">${escapeHtml(formatVnd(order.depositTotal))}</div>
        <div style="color:#5d6a74;text-align:right;font-weight:600">Total</div>
        <div style="text-align:right;font-weight:600">${escapeHtml(formatVnd(ctx.total))}</div>
        <div style="color:#5d6a74;text-align:right">Paid</div>
        <div style="text-align:right">${escapeHtml(formatVnd(order.amountPaid))}</div>
        <div style="text-align:right;font-weight:700;font-size:15px">Balance due</div>
        <div style="text-align:right;font-weight:700;font-size:15px;color:${ctx.balanceDue > 0 ? "#c0392b" : "#0b7a63"}">${escapeHtml(formatVnd(ctx.balanceDue))}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 220px;gap:24px;margin-top:24px;padding-top:16px;border-top:1px dashed #ccc;align-items:start">
        ${bankBlock}
        ${qrBlock}
      </div>

      <div style="margin-top:20px;font-size:11px;color:#888;text-align:center">
        Thank you for choosing ${escapeHtml(b.businessName || "us")}. Questions? Contact us on WhatsApp / Zalo — details on our website.
      </div>
    </div>
  `;
}

export async function attachQrToPreview(ctx, root) {
  if (!ctx.qrPayload) return;
  const slot = root.querySelector("#invoice-qr-slot");
  if (!slot) return;
  try {
    const dataUrl = await renderQrDataUrl(ctx.qrPayload);
    slot.innerHTML = `<img alt="Scan to pay" src="${dataUrl}" style="width:200px;height:200px;display:block">`;
  } catch (error) {
    slot.textContent = "QR could not be generated.";
  }
}

export async function generateInvoicePdf(ctx) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 15;
  let y = 20;

  const b = ctx.business || {};
  const order = ctx.order || {};

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(11, 122, 99);
  doc.text(ctx.invoiceTitle, marginX, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(93, 106, 116);
  doc.text(ctx.isDraft ? "Preview / not yet finalized" : "Delivered and issued", marginX, y + 5);

  doc.setFontSize(10);
  doc.setTextColor(20, 38, 49);
  doc.text(`No. ${ctx.invoiceNumber}`, pageWidth - marginX, y, { align: "right" });
  doc.text(`Issued: ${ctx.issuedDate}`, pageWidth - marginX, y + 5, { align: "right" });
  if (order.deliveryDate) doc.text(`Delivery: ${order.deliveryDate}`, pageWidth - marginX, y + 10, { align: "right" });
  doc.text(`Status: ${order.status || "unknown"}`, pageWidth - marginX, y + 15, { align: "right" });

  y += 26;
  doc.setDrawColor(11, 122, 99);
  doc.setLineWidth(0.6);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  // Business + customer blocks
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(b.businessName || b.legalName || "Vietnam Sparkle", marginX, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  let by = y + 5;
  if (b.legalName && b.legalName !== b.businessName) { doc.text(b.legalName, marginX, by); by += 4.5; }
  if (b.taxCode) { doc.text(`Tax code: ${b.taxCode}`, marginX, by); by += 4.5; }
  if (b.registeredAddress) { doc.text(b.registeredAddress, marginX, by, { maxWidth: 80 }); by += 4.5; }

  const customerX = pageWidth / 2 + 5;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Deliver to", customerX, y);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  let cy = y + 5;
  if (order.customerName) { doc.text(order.customerName, customerX, cy); cy += 4.5; }
  if (order.phone) { doc.text(order.phone, customerX, cy); cy += 4.5; }
  if (order.address) { doc.text(order.address, customerX, cy, { maxWidth: 80 }); cy += 4.5; }
  if (order.deliveryDate) {
    doc.text(`Delivery: ${order.deliveryDate}${order.deliveryWindow ? " · " + order.deliveryWindow : ""}`, customerX, cy);
    cy += 4.5;
  }

  y = Math.max(by, cy) + 6;

  // Items table
  doc.setFillColor(11, 122, 99, 0.08);
  doc.setDrawColor(220, 220, 220);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 38, 49);
  const col1 = marginX;
  const col2 = pageWidth - marginX - 90;
  const col3 = pageWidth - marginX - 55;
  const col4 = pageWidth - marginX;
  doc.text("Item", col1, y);
  doc.text("Qty", col2, y, { align: "right" });
  doc.text("Unit price", col3, y, { align: "right" });
  doc.text("Line total", col4, y, { align: "right" });
  y += 3;
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 5;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const items = ctx.items || [];
  if (!items.length) {
    doc.setTextColor(140, 140, 140);
    doc.text("No line items on file.", marginX, y);
    y += 6;
  } else {
    items.forEach((item) => {
      doc.text(String(item.productName || item.productId || ""), col1, y, { maxWidth: 90 });
      doc.text(String(Number(item.quantity || 0)), col2, y, { align: "right" });
      doc.text(formatVnd(item.unitPrice), col3, y, { align: "right" });
      doc.text(formatVnd(item.lineTotal || (Number(item.unitPrice || 0) * Number(item.quantity || 0))), col4, y, { align: "right" });
      y += 6;
      doc.setDrawColor(230, 230, 230);
      doc.line(marginX, y - 2, pageWidth - marginX, y - 2);
    });
  }

  // Totals
  y += 4;
  const totalsX = pageWidth - marginX - 60;
  const totalsValX = pageWidth - marginX;
  const totalsRow = (label, value, opts = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.big ? 12 : 10);
    doc.setTextColor(opts.color || (opts.bold ? 20 : 93), opts.color ? 0 : 106, opts.color ? 0 : 116);
    doc.text(label, totalsX, y, { align: "right" });
    doc.text(value, totalsValX, y, { align: "right" });
    y += opts.big ? 7 : 5.5;
  };
  totalsRow("Subtotal", formatVnd(order.subtotal));
  totalsRow("Container deposit", formatVnd(order.depositTotal));
  totalsRow("Total", formatVnd(ctx.total), { bold: true });
  totalsRow("Paid", formatVnd(order.amountPaid));
  const dueColor = ctx.balanceDue > 0 ? [192, 57, 43] : [11, 122, 99];
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(dueColor[0], dueColor[1], dueColor[2]);
  doc.text("Balance due", totalsX, y, { align: "right" });
  doc.text(formatVnd(ctx.balanceDue), totalsValX, y, { align: "right" });
  y += 12;

  // Bank + QR
  doc.setDrawColor(200, 200, 200);
  doc.setLineDashPattern([1, 1], 0);
  doc.line(marginX, y, pageWidth - marginX, y);
  doc.setLineDashPattern([], 0);
  y += 6;

  const bank = ctx.bank || {};
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 38, 49);
  doc.text("Bank transfer", marginX, y);
  doc.setFont("helvetica", "normal");
  let bky = y + 5;
  if (bank.name) { doc.text(bank.name, marginX, bky); bky += 4.5; }
  if (bank.accountName) { doc.text(bank.accountName, marginX, bky); bky += 4.5; }
  if (bank.accountNumber) {
    doc.setFont("courier", "normal");
    doc.text(bank.accountNumber, marginX, bky);
    doc.setFont("helvetica", "normal");
    bky += 4.5;
  }
  doc.text(`Reference: ${order.id}`, marginX, bky);
  bky += 4.5;

  if (!bank.accountNumber) {
    doc.setTextColor(140, 140, 140);
    doc.text("Bank details not configured in settings.", marginX, y + 5);
    doc.setTextColor(20, 38, 49);
  }

  // QR on the right
  if (ctx.qrPayload) {
    try {
      const dataUrl = await renderQrDataUrl(ctx.qrPayload);
      if (dataUrl) {
        const qrSize = 42;
        doc.addImage(dataUrl, "PNG", pageWidth - marginX - qrSize, y, qrSize, qrSize);
        doc.setFontSize(8);
        doc.setTextColor(93, 106, 116);
        doc.text("Scan to pay", pageWidth - marginX - qrSize / 2, y + qrSize + 4, { align: "center" });
      }
    } catch (_) {
      // silently skip QR if generation fails
    }
  }

  y = Math.max(bky, y + 50);

  doc.setFontSize(8);
  doc.setTextColor(140, 140, 140);
  const footer = `Thank you for choosing ${b.businessName || "us"}. Questions? Contact us on WhatsApp / Zalo — details on our website.`;
  doc.text(footer, pageWidth / 2, doc.internal.pageSize.getHeight() - 12, { align: "center", maxWidth: pageWidth - 30 });

  return doc;
}

// mailto: cannot attach files. The workflow this returns is a mailto: URL
// with subject + body pre-filled; the caller downloads the PDF locally first
// and the owner attaches it to the email in their client. Best we can do
// without a mail service. Returns null when the customer has no email on file.
export function buildEmailShare(ctx) {
  const order = ctx.order || {};
  const to = order.email || (ctx.customer && ctx.customer.email) || "";
  if (!to) return null;
  const b = ctx.business || {};
  const businessName = b.businessName || "Vietnam Sparkle";
  const subject = `${ctx.invoiceTitle} · ${order.id} — ${businessName}`;
  const lines = [
    `Hi ${order.customerName || ""},`,
    "",
    `Please find your ${ctx.isDraft ? "order confirmation" : "invoice"} attached (PDF is downloading to your device — please attach it to this email before sending).`,
    "",
    `Order: ${order.id}`,
    `Delivery: ${order.deliveryDate || "TBD"}${order.deliveryWindow ? " (" + order.deliveryWindow + ")" : ""}`,
    `Total: ${formatVnd(ctx.total)}`,
    ctx.balanceDue > 0 ? `Balance due: ${formatVnd(ctx.balanceDue)}` : "Paid in full — thank you!",
    ctx.bank && ctx.bank.accountNumber
      ? `\nBank transfer: ${ctx.bank.name || ""}\nAccount: ${ctx.bank.accountName || ""} (${ctx.bank.accountNumber})\nReference: ${order.id}`
      : "",
    "",
    "Thank you,",
    businessName
  ].filter(Boolean);
  const body = lines.join("\n");
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function buildWhatsAppShare(ctx) {
  const order = ctx.order || {};
  const phone = String(order.phone || "").replace(/[^0-9+]/g, "").replace(/^\+/, "");
  if (!phone) return null;
  const lines = [
    `Hi ${order.customerName || ""}, here is your ${ctx.isDraft ? "order confirmation" : "invoice"} for ${order.id}.`,
    `Delivery: ${order.deliveryDate || "TBD"}${order.deliveryWindow ? " (" + order.deliveryWindow + ")" : ""}`,
    `Total: ${formatVnd(ctx.total)}`,
    ctx.balanceDue > 0 ? `Balance due: ${formatVnd(ctx.balanceDue)}` : `Paid in full — thank you!`,
    ctx.bank && ctx.bank.accountNumber ? `Bank transfer: ${ctx.bank.name || ""} ${ctx.bank.accountNumber} (${ctx.bank.accountName || ""})` : ""
  ].filter(Boolean);
  const text = lines.join("\n");
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}
