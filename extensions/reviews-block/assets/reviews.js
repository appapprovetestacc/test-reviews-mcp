// Storefront reviews block. Progressive enhancement: liquid renders
// the heading + form skeleton; this script hydrates the summary, list,
// pagination, photo upload, and submit handlers.
//
// All requests go to the app proxy at /apps/reviews/*. Shopify signs
// every proxied request with the API secret — the Worker verifies the
// signature before serving JSON.

(function () {
  if (typeof window === "undefined" || !document) return;

  const PROXY_BASE = "/apps/reviews";

  function init(root) {
    const productId = root.getAttribute("data-product-id");
    if (!productId) return;
    const pageSize = clampInt(root.getAttribute("data-page-size") || "5", 1, 25);
    const showQa = root.getAttribute("data-show-qa") === "1";
    const allowPhotos = root.getAttribute("data-allow-photos") === "1";

    const state = {
      page: 1,
      pageSize,
      total: 0,
      productId,
    };

    const summaryEl = root.querySelector("[data-rv-summary]");
    const listEl = root.querySelector("[data-rv-list]");
    const paginationEl = root.querySelector("[data-rv-pagination]");
    const formEl = root.querySelector("[data-rv-form]");
    const formStatus = root.querySelector("[data-rv-form-status]");
    const submitBtn = root.querySelector("[data-rv-submit]");
    const submitLabel = root.querySelector("[data-rv-submit-label]");
    const photoField = root.querySelector("[data-rv-photo-field]");
    const photoInput = root.querySelector("[data-rv-photo]");

    if (allowPhotos && photoField) {
      photoField.removeAttribute("hidden");
    }

    function loadReviews() {
      fetch(
        `${PROXY_BASE}/list?productId=${encodeURIComponent(productId)}&page=${state.page}&pageSize=${state.pageSize}`,
        { credentials: "same-origin", headers: { Accept: "application/json" } },
      )
        .then((r) => r.json())
        .then((data) => {
          if (!data || !data.ok) {
            renderSummary({ summary: { total: 0, average: 0, counts: {} } });
            listEl.innerHTML = "";
            paginationEl.innerHTML = "";
            return;
          }
          state.total = data.total;
          renderSummary(data);
          renderList(data.items);
          renderPagination(data);
        })
        .catch(() => {
          // Network error — keep the previous render. The user can retry.
        });
    }

    function renderSummary(data) {
      const s = data.summary || { total: 0, average: 0, counts: {} };
      const total = s.total || 0;
      const avg = s.average || 0;
      const stars = renderStars(avg);
      const histogram = [5, 4, 3, 2, 1]
        .map((n) => {
          const c = s.counts?.[n] || 0;
          const pct = total ? Math.round((c / total) * 100) : 0;
          return `
            <span>${n}★</span>
            <span class="rv-summary__bar"><span class="rv-summary__bar-fill" style="width:${pct}%"></span></span>
            <span>${c}</span>
          `;
        })
        .join("");
      summaryEl.innerHTML = `
        <span class="rv-summary__average">${avg.toFixed(1)}</span>
        <span class="rv-summary__stars" aria-label="Average rating ${avg.toFixed(1)} out of 5">${stars}</span>
        <span class="rv-summary__count">${total} review${total === 1 ? "" : "s"}</span>
        <span class="rv-summary__histogram" aria-hidden="true">${histogram}</span>
      `;
    }

    function renderList(items) {
      if (!items || !items.length) {
        listEl.innerHTML = `<li class="rv-item rv-item--empty"><p>No reviews yet — be the first to share!</p></li>`;
        return;
      }
      listEl.innerHTML = items
        .map((r) => {
          const stars = renderStars(r.rating);
          const verified = r.verified
            ? `<span class="rv-item__verified">Verified buyer</span>`
            : "";
          const photo = r.photoUrl
            ? `<div class="rv-item__photo"><img src="${escapeAttr(r.photoUrl)}" alt="Photo from ${escapeAttr(r.customerName)}" loading="lazy"></div>`
            : "";
          const reply = r.reply
            ? `<div class="rv-item__reply"><strong>Store reply:</strong> ${escapeHtml(r.reply)}</div>`
            : "";
          const date = new Date(r.createdAt).toLocaleDateString();
          return `
            <li class="rv-item">
              <div class="rv-item__head">
                <span class="rv-item__stars" aria-label="${r.rating} out of 5">${stars}</span>
                <span class="rv-item__title">${escapeHtml(r.title || "")}</span>
                ${verified}
              </div>
              <div class="rv-item__meta">${escapeHtml(r.customerName)} · ${date}</div>
              <p class="rv-item__body">${escapeHtml(r.body)}</p>
              ${photo}
              ${reply}
            </li>`;
        })
        .join("");
    }

    function renderPagination(data) {
      const totalPages = Math.max(1, Math.ceil(data.total / state.pageSize));
      if (totalPages <= 1) {
        paginationEl.innerHTML = "";
        return;
      }
      paginationEl.innerHTML = `
        <button type="button" data-rv-prev ${data.page <= 1 ? "disabled" : ""}>Previous</button>
        <span class="rv-pagination__current">Page ${data.page} of ${totalPages}</span>
        <button type="button" data-rv-next ${data.page >= totalPages ? "disabled" : ""}>Next</button>
      `;
      paginationEl.querySelector("[data-rv-prev]")?.addEventListener("click", () => {
        if (state.page > 1) {
          state.page -= 1;
          loadReviews();
        }
      });
      paginationEl.querySelector("[data-rv-next]")?.addEventListener("click", () => {
        if (state.page < totalPages) {
          state.page += 1;
          loadReviews();
        }
      });
    }

    formEl?.addEventListener("submit", async (event) => {
      event.preventDefault();
      formStatus.textContent = "";
      formStatus.removeAttribute("data-tone");
      submitBtn.setAttribute("disabled", "disabled");
      submitLabel.textContent = "Sending…";

      try {
        let photoUrl = "";
        if (allowPhotos && photoInput?.files?.[0]) {
          const photoForm = new FormData();
          photoForm.set("productId", productId);
          photoForm.set("photo", photoInput.files[0]);
          const r = await fetch(`${PROXY_BASE}/upload`, {
            method: "POST",
            credentials: "same-origin",
            body: photoForm,
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j && j.ok) {
            photoUrl = j.url || "";
          } else if (j && j.error) {
            // Photo failed but we can still submit the text review.
            console.warn("[reviews] photo upload skipped:", j.error);
          }
        }

        const formData = new FormData(formEl);
        formData.set("productId", productId);
        if (photoUrl) formData.set("photoUrl", photoUrl);
        const params = new URLSearchParams();
        for (const [k, v] of formData.entries()) {
          if (k === "photo") continue;
          if (typeof v === "string") params.append(k, v);
        }
        const res = await fetch(`${PROXY_BASE}/submit`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: params.toString(),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          formStatus.textContent =
            "Thanks! Your review will appear once the merchant approves it.";
          formStatus.setAttribute("data-tone", "success");
          formEl.reset();
        } else {
          const msg =
            (data.errors && data.errors.map((e) => e.message).join(" ")) ||
            (data.error ?? "Something went wrong. Please try again.");
          formStatus.textContent = msg;
          formStatus.setAttribute("data-tone", "error");
        }
      } catch (err) {
        formStatus.textContent =
          "Couldn't reach the review server. Please try again in a moment.";
        formStatus.setAttribute("data-tone", "error");
      } finally {
        submitBtn.removeAttribute("disabled");
        submitLabel.textContent = "Submit review";
      }
    });

    loadReviews();

    if (showQa) {
      initQa(root, productId);
    }
  }

  function initQa(root, productId) {
    const listEl = root.querySelector("[data-rv-qa-list]");
    const formEl = root.querySelector("[data-rv-qa-form]");
    const statusEl = root.querySelector("[data-rv-qa-status]");
    const submitBtn = root.querySelector("[data-rv-qa-submit]");
    const submitLabel = root.querySelector("[data-rv-qa-submit-label]");

    fetch(
      `${PROXY_BASE}/qa/list?productId=${encodeURIComponent(productId)}&page=1&pageSize=20`,
      { credentials: "same-origin", headers: { Accept: "application/json" } },
    )
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok || !data.items?.length) {
          listEl.innerHTML = `<li class="rv-qa-item rv-qa-item--empty"><p>No questions yet — ask the first one!</p></li>`;
          return;
        }
        listEl.innerHTML = data.items
          .map((q) => {
            const answer = q.answer
              ? `<div class="rv-qa-item__answer"><strong>Answer:</strong> ${escapeHtml(q.answer)}</div>`
              : "";
            const date = new Date(q.createdAt).toLocaleDateString();
            return `
              <li class="rv-qa-item">
                <div class="rv-item__meta">${escapeHtml(q.customerName)} · ${date}</div>
                <p class="rv-item__body"><strong>Q:</strong> ${escapeHtml(q.body)}</p>
                ${answer}
              </li>`;
          })
          .join("");
      })
      .catch(() => {});

    formEl?.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusEl.textContent = "";
      statusEl.removeAttribute("data-tone");
      submitBtn.setAttribute("disabled", "disabled");
      submitLabel.textContent = "Sending…";
      try {
        const fd = new FormData(formEl);
        fd.set("productId", productId);
        const params = new URLSearchParams();
        for (const [k, v] of fd.entries()) {
          if (typeof v === "string") params.append(k, v);
        }
        const res = await fetch(`${PROXY_BASE}/qa/submit`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: params.toString(),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          statusEl.textContent =
            "Thanks! Your question will appear once the merchant approves it.";
          statusEl.setAttribute("data-tone", "success");
          formEl.reset();
        } else {
          const msg =
            (data.errors && data.errors.map((e) => e.message).join(" ")) ||
            (data.error ?? "Something went wrong.");
          statusEl.textContent = msg;
          statusEl.setAttribute("data-tone", "error");
        }
      } catch {
        statusEl.textContent = "Couldn't reach the server. Try again later.";
        statusEl.setAttribute("data-tone", "error");
      } finally {
        submitBtn.removeAttribute("disabled");
        submitLabel.textContent = "Send question";
      }
    });
  }

  function renderStars(rating) {
    const r = Math.round(Number(rating) || 0);
    const full = Math.max(0, Math.min(5, r));
    return "★".repeat(full) + "☆".repeat(5 - full);
  }

  function clampInt(raw, min, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function escapeHtml(s) {
    if (typeof s !== "string") return "";
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function boot() {
    document.querySelectorAll("[data-rv-block]").forEach((el) => {
      if (el.dataset.rvHydrated === "1") return;
      el.dataset.rvHydrated = "1";
      try {
        init(el);
      } catch (err) {
        console.error("[reviews] failed to hydrate", err);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  // Hydrate again when Shopify section reloads (theme editor).
  document.addEventListener("shopify:section:load", boot);
})();
