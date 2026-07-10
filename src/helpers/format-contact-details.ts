import { Address, Contact, Phone } from "xero-node";

function hasText(value: string | undefined | null): value is string {
  return Boolean(value && value.trim());
}

function addressLabel(type: Address.AddressTypeEnum | undefined): string {
  switch (type) {
    case Address.AddressTypeEnum.STREET:
      return "Street";
    case Address.AddressTypeEnum.POBOX:
      return "Postal";
    default:
      return type ?? "Address";
  }
}

function isEmptyAddress(a: Address): boolean {
  return ![
    a.attentionTo,
    a.addressLine1,
    a.addressLine2,
    a.addressLine3,
    a.addressLine4,
    a.city,
    a.region,
    a.postalCode,
    a.country,
  ].some(hasText);
}

/**
 * Render a contact's addresses as text lines. Xero returns placeholder
 * STREET/POBOX rows with every field blank, so those are skipped. Returns an
 * empty array when there is nothing to show (e.g. summaryOnly responses that
 * omit addresses entirely).
 */
export function formatAddressLines(contact: Contact): string[] {
  const addresses = (contact.addresses ?? []).filter((a) => !isEmptyAddress(a));
  if (addresses.length === 0) return [];

  const lines = ["Addresses:"];
  for (const a of addresses) {
    const cityRegionPostal = [a.city, a.region, a.postalCode]
      .filter(hasText)
      .join(", ");
    const parts = [
      hasText(a.attentionTo) ? `Attn: ${a.attentionTo}` : null,
      a.addressLine1,
      a.addressLine2,
      a.addressLine3,
      a.addressLine4,
      cityRegionPostal || null,
      a.country,
    ].filter(hasText);
    lines.push(`  ${addressLabel(a.addressType)}: ${parts.join(" | ")}`);
  }
  return lines;
}

function isEmptyPhone(p: Phone): boolean {
  return ![p.phoneNumber, p.phoneAreaCode, p.phoneCountryCode].some(hasText);
}

/**
 * Render a contact's phone numbers as text lines. Xero returns a row for every
 * phone type (mostly blank), so empty rows are skipped. Returns an empty array
 * when there is nothing to show.
 */
export function formatPhoneLines(contact: Contact): string[] {
  const phones = (contact.phones ?? []).filter((p) => !isEmptyPhone(p));
  if (phones.length === 0) return [];

  const lines = ["Phones:"];
  for (const p of phones) {
    const number = [p.phoneCountryCode, p.phoneAreaCode, p.phoneNumber]
      .filter(hasText)
      .join(" ");
    lines.push(`  ${p.phoneType ?? "Phone"}: ${number}`);
  }
  return lines;
}
