// The three dialogs: send this moment, paint somewhere else, map data.
import type { SceneBundle } from "../../shared/bundle.ts";
import type { Postcard } from "./main.ts";

interface Api {
  load(cell: string, opts?: { postcard?: Postcard | null }): Promise<void>;
  freeze(): { postcard: Omit<Postcard, "id" | "note">; share: HTMLCanvasElement } | null;
  currentBundle(): SceneBundle | null;
}
let api: Api;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupDialogs(a: Api) {
  api = a;
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
    d.querySelector(".close")?.addEventListener("click", () => d.close());
  }
  const note = $<HTMLTextAreaElement>("send-note"), count = $("send-count");
  note.addEventListener("input", () => { count.textContent = `${note.value.length} / 140`; });
  $<HTMLFormElement>("send-form").addEventListener("submit", ev => { ev.preventDefault(); send(); });
  $<HTMLFormElement>("search-form").addEventListener("submit", ev => { ev.preventDefault(); search(); });
  $("send-copy").addEventListener("click", async () => {
    const url = $<HTMLInputElement>("send-url").value;
    try { await navigator.clipboard.writeText(url); $("send-copy").textContent = "Copied"; } catch { $<HTMLInputElement>("send-url").select(); }
  });
}

let frozen: ReturnType<Api["freeze"]> = null;
export function openSend() {
  frozen = api.freeze();
  if (!frozen) return;
  const d = $<HTMLDialogElement>("send");
  $("send-result").hidden = true; $<HTMLFormElement>("send-form").hidden = false; $("send-error").textContent = "";
  const prev = $<HTMLCanvasElement>("send-preview"); prev.width = 600; prev.height = 315; prev.getContext("2d")!.drawImage(frozen.share, 0, 0, 600, 315);
  d.showModal();
  $<HTMLTextAreaElement>("send-note").focus();
}

async function send() {
  if (!frozen) return;
  const btn = $<HTMLButtonElement>("send-go"); btn.disabled = true; btn.textContent = "Sending…";
  try {
    const blob: Blob = await new Promise((res, rej) => frozen!.share.toBlob(b => (b ? res(b) : rej(new Error("no image"))), "image/jpeg", 0.86));
    const image = await new Promise<string>(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); });
    const note = $<HTMLTextAreaElement>("send-note").value.slice(0, 140);
    const r = await fetch("/postcard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...frozen.postcard, note, image }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "The postcard did not send.");
    const url = new URL(`/p/${j.id}`, location.origin).toString();
    $<HTMLInputElement>("send-url").value = url;
    $<HTMLFormElement>("send-form").hidden = true; $("send-result").hidden = false; $("send-copy").textContent = "Copy link";
    if (navigator.share) $("send-share").onclick = () => navigator.share({ title: "A moment", text: frozen!.postcard.label, url }).catch(() => {});
    else $("send-share").hidden = true;
  } catch (err) {
    $("send-error").textContent = String((err as Error).message || err);
  } finally { btn.disabled = false; btn.textContent = "Send this moment"; }
}

export function openSearch() {
  $("search-results").innerHTML = ""; $("search-error").textContent = "";
  $<HTMLDialogElement>("search").showModal(); $<HTMLInputElement>("search-q").focus();
}
async function search() {
  const q = $<HTMLInputElement>("search-q").value.trim(); if (!q) return;
  const list = $("search-results"); list.innerHTML = ""; $("search-error").textContent = "Looking…";
  try {
    const r = await fetch(`/search?q=${encodeURIComponent(q)}`); const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Search failed.");
    $("search-error").textContent = j.results.length ? "" : "No place by that name. Try a town or a landmark.";
    for (const res of j.results as { label: string; cell: string }[]) {
      const li = document.createElement("li"), b = document.createElement("button"); b.type = "button"; b.textContent = res.label;
      b.addEventListener("click", () => { $<HTMLDialogElement>("search").close(); history.replaceState(null, "", "/"); document.body.classList.remove("postcard"); api.load(res.cell); });
      li.append(b); list.append(li);
    }
  } catch (err) { $("search-error").textContent = String((err as Error).message || err); }
}

export function openCredits() {
  const b = api.currentBundle();
  const list = $("credits-list"); list.innerHTML = "";
  for (const a of [...(b?.attribution ?? []), "Weather: Open-Meteo.com (CC BY 4.0)", "Place names: Photon by komoot, from OpenStreetMap"]) { const li = document.createElement("li"); li.textContent = a; list.append(li); }
  $<HTMLDialogElement>("credits").showModal();
}
