"""Kapı ekranı: dönen QR kodu ve giriş sonucu mesajlarını gösterir."""
import queue
import tkinter as tk

import qrcode
from PIL import ImageTk

BG = "#0f172a"
FG = "#e2e8f0"
GREEN = "#16a34a"
RED = "#dc2626"
ORANGE = "#d97706"
MESSAGE_MS = 3500


def render_qr(code, size):
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
    qr.add_data(code)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return img.resize((size, size), resample=0)  # NEAREST: keskin kenarlar, okuması kolay


class GateWindow:
    def __init__(self, events, fullscreen):
        self.events = events  # queue.Queue; (kind, data) çiftleri
        self.root = tk.Tk()
        self.root.title("GYM Enter - Kapı")
        self.root.configure(bg=BG)
        self.root.bind("<Escape>", lambda _e: self.root.destroy())
        if fullscreen:
            self.root.attributes("-fullscreen", True)
            self.root.config(cursor="none")
        else:
            self.root.geometry("800x600")

        self.title = tk.Label(self.root, text="Giriş için uygulamadan QR kodu okutun", bg=BG, fg=FG, font=("Segoe UI", 22))
        self.title.pack(pady=(24, 8))
        self.qr_label = tk.Label(self.root, bg=BG)
        self.qr_label.pack(expand=True)
        self.banner = tk.Label(self.root, text="", bg=BG, fg=FG, font=("Segoe UI", 28, "bold"), pady=14)
        self.banner.pack(fill="x")
        # İnternet yokken kapı serbest geçişteyse kalıcı uyarı (giriş mesajlarından ayrı)
        self.hold_banner = tk.Label(self.root, text="", bg=BG, fg="white", font=("Segoe UI", 16, "bold"), pady=6)
        self.hold_banner.pack(fill="x")
        self.status = tk.Label(self.root, text="", bg=BG, fg="#94a3b8", font=("Segoe UI", 12))
        self.status.pack(pady=(0, 8))

        self._photo = None
        self._banner_job = None
        self._holding = False
        self.root.after(100, self._poll)

    def _qr_size(self):
        self.root.update_idletasks()
        return max(200, int(min(self.root.winfo_width(), self.root.winfo_height()) * 0.6))

    def _show_qr(self, code):
        self._photo = ImageTk.PhotoImage(render_qr(code, self._qr_size()))
        self.qr_label.configure(image=self._photo, text="")

    def _hide_qr(self, text):
        self._photo = None
        self.qr_label.configure(image="", text=text, fg="#94a3b8", font=("Segoe UI", 24))

    def _flash(self, text, color):
        if self._banner_job:
            self.root.after_cancel(self._banner_job)
        self.banner.configure(text=text, bg=color, fg="white")
        self._banner_job = self.root.after(MESSAGE_MS, lambda: self.banner.configure(text="", bg=BG))

    def _handle(self, kind, data):
        if kind == "qr":
            self._show_qr(data["code"])
        elif kind == "open":
            self._flash(f"Hoş geldin {data['name']}", GREEN)
        elif kind == "deny":
            who = f"{data['name']}: " if data["name"] else ""
            self._flash(f"{who}{data['message']}", RED)
        elif kind == "hold":
            self._holding = data["active"]
            if self._holding:
                self.hold_banner.configure(text="İnternet bağlantısı yok: kapı serbest geçişe açık", bg=ORANGE)
                self._hide_qr("Serbest geçiş: kapı açık")
            else:
                self.hold_banner.configure(text="", bg=BG)
                self._hide_qr("Kapı şu an çevrimdışı")  # bağlantı gelince QR yeniden çizilir
        elif kind == "status":
            self.status.configure(text=data["text"])
            if data["state"] != "online" and not self._holding:
                self._hide_qr("Kapı şu an çevrimdışı")

    def _poll(self):
        try:
            while True:
                kind, data = self.events.get_nowait()
                self._handle(kind, data)
        except queue.Empty:
            pass
        self.root.after(100, self._poll)

    def run(self):
        self.root.mainloop()
