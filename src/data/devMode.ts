import { useEffect, useState } from "react";

/** 개발자 메뉴 on/off (기본 꺼짐). 이 기기 브라우저에만 저장. */
const KEY = "oc_dev_mode";
const EVT = "oc-dev-mode-change";

export function isDevMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(EVT));
}

export function useDevMode(): boolean {
  const [on, setOn] = useState<boolean>(isDevMode);
  useEffect(() => {
    const h = () => setOn(isDevMode());
    window.addEventListener(EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return on;
}
