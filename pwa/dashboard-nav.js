const nav = document.getElementById("dashboard-nav");
const pages = [...document.querySelectorAll("[data-page]")];
function show(view) {
  for (const page of pages) {
    page.classList.toggle("inactive-page", page.dataset.page !== view);
    if (page.dataset.page === view && page.tagName === "DETAILS") page.open = true;
  }
  for (const button of nav.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === view));
}
nav.addEventListener("click", event => {
  const button = event.target.closest("button[data-view]");
  if (button) show(button.dataset.view);
});
show("home");
