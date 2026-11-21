// Тайминг экрана запуска — общий для обоих приложений (как theme.js):
// логика без разметки. Сам экран у каждого свой — BootScreen в
// src/ui.jsx и src/admin/components/BootScreen.jsx (общий только файл
// картинки /loading/mascot.webp).

import { useEffect, useState } from "react";

// Не мигать: даже мгновенный запуск держит экран хотя бы столько.
const MIN_MS = 600;
// = transition: opacity 0.35s у .boot-screen в обоих CSS.
const FADE_MS = 350;

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Фаза экрана запуска: "on" → "leaving" (затухание) → "off", назад не
 * возвращается — сохранения и опросы его больше не поднимают. ready —
 * начальная загрузка закончилась (успехом или экраном, которому слой не
 * нужен). С prefers-reduced-motion затухания нет: сразу "off".
 */
export function useBootPhase(ready) {
  const [phase, setPhase] = useState("on");
  const [startedAt] = useState(() => performance.now());

  useEffect(() => {
    if (!ready || phase !== "on") return;
    const wait = Math.max(0, MIN_MS - (performance.now() - startedAt));
    const t = window.setTimeout(() => setPhase(reducedMotion() ? "off" : "leaving"), wait);
    return () => window.clearTimeout(t);
  }, [ready, phase, startedAt]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const t = window.setTimeout(() => setPhase("off"), FADE_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  return phase;
}
