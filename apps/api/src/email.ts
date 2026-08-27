import nodemailer from "nodemailer";
import { serverConfig } from "./config";

const config = serverConfig();
const transport = nodemailer.createTransport(config.smtpUrl);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function sendVerificationEmail(input: {
  email: string;
  name: string;
  url: string;
}): Promise<void> {
  const safeName = escapeHtml(input.name || "there");
  const safeUrl = escapeHtml(input.url);
  await transport.sendMail({
    from: config.emailFrom,
    to: input.email,
    subject: "Verify your Cinesim email",
    text: `Hi ${input.name || "there"},\n\nVerify your Cinesim email:\n${input.url}\n\nIf you did not create this account, you can ignore this email.`,
    html: `<p>Hi ${safeName},</p><p>Verify your Cinesim email to finish signing in.</p><p><a href="${safeUrl}">Verify email</a></p><p>If you did not create this account, you can ignore this email.</p>`,
  });
}

export async function sendPasswordResetEmail(input: {
  email: string;
  name: string;
  url: string;
}): Promise<void> {
  const safeName = escapeHtml(input.name || "there");
  const safeUrl = escapeHtml(input.url);
  await transport.sendMail({
    from: config.emailFrom,
    to: input.email,
    subject: "Reset your Cinesim password",
    text: `Hi ${input.name || "there"},\n\nReset your Cinesim password:\n${input.url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Hi ${safeName},</p><p>Use the link below to reset your Cinesim password.</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
  });
}
