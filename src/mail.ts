function env(name: string): string {
  return process.env[name]?.trim() || "";
}

export function demoInbox(): string {
  return env("DEMO_CUSTOMER_EMAIL") || "hatim@hatim.com";
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "the email on file";
  const keep = local.slice(0, Math.min(2, local.length));
  return `${keep}***@${domain}`;
}

export type MailResult =
  | { ok: true; via: "resend" | "smtp" }
  | { ok: false; reason: string };

export async function sendMail(input: { to: string; subject: string; text: string }): Promise<MailResult> {
  if (!input.to) return { ok: false, reason: "No recipient" };

  const resendKey = env("RESEND_API_KEY");
  if (resendKey) {
    const from = env("MAIL_FROM") || "Order Support <beth.t@example.com>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `Resend ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true, via: "resend" };
  }

  const smtpHost = env("MAIL_SMTP_HOST");
  if (smtpHost) {
    const nodemailer = (await import("nodemailer")).default;
    const smtpPort = Number(env("MAIL_SMTP_PORT") || "1025");
    const smtpUser = env("MAIL_SMTP_USER");
    const smtpPass = env("MAIL_SMTP_PASSWORD");
    const from = env("MAIL_FROM") || "Order Support <noreply@local.test>";
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      tls: { rejectUnauthorized: false },
      ...(smtpUser && smtpPass ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
    });
    await transport.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    return { ok: true, via: "smtp" };
  }

  return { ok: false, reason: "No mail provider configured" };
}
