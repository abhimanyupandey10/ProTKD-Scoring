document.addEventListener("DOMContentLoaded", () => {
  const copyBtn = document.getElementById("copy_code");
  const codeInput = document.getElementById("machine_code");
  const pwInput = document.getElementById("match_pw_input");

  copyBtn?.addEventListener("click", () => {
    codeInput.select();
    document.execCommand("copy");
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 800);
  });

  // Persist typed match password locally (auto-save behavior for operator convenience)
  pwInput?.addEventListener("input", () => {
    try { localStorage.setItem("match_password", pwInput.value); } catch {}
  });

  // Pre-fill from storage if present
  try {
    const saved = localStorage.getItem("match_password");
    if (saved && pwInput) pwInput.value = saved;
  } catch {}
});
