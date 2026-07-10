import { z } from "zod";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { getXeroContact } from "../../handlers/get-xero-contact.handler.js";
import {
  formatAddressLines,
  formatPhoneLines,
} from "../../helpers/format-contact-details.js";

const GetContactTool = CreateXeroTool(
  "get-contact",
  "Get a single contact from Xero by its ContactID, including full detail that \
list-contacts omits by default: street & postal addresses, phone numbers, and \
contact persons. Use list-contacts first to find the ContactID.",
  {
    contactId: z
      .string()
      .describe(
        "The Xero ContactID of the contact to retrieve (obtained from list-contacts).",
      ),
  },
  async ({ contactId }) => {
    const response = await getXeroContact(contactId);

    if (response.isError || !response.result) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error getting contact: ${response.error}`,
          },
        ],
      };
    }

    const contact = response.result;

    const contactPersonLines = contact.contactPersons?.length
      ? [
          "Contact Persons:",
          ...contact.contactPersons.map(
            (p) =>
              `  ${[p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)"}${
                p.emailAddress ? ` <${p.emailAddress}>` : ""
              }`,
          ),
        ]
      : [];

    const text = [
      `Contact: ${contact.name}`,
      `ID: ${contact.contactID}`,
      contact.firstName ? `First Name: ${contact.firstName}` : null,
      contact.lastName ? `Last Name: ${contact.lastName}` : null,
      contact.emailAddress ? `Email: ${contact.emailAddress}` : "No email",
      contact.accountsReceivableTaxType
        ? `AR Tax Type: ${contact.accountsReceivableTaxType}`
        : null,
      contact.accountsPayableTaxType
        ? `AP Tax Type: ${contact.accountsPayableTaxType}`
        : null,
      `Type: ${
        [
          contact.isCustomer ? "Customer" : null,
          contact.isSupplier ? "Supplier" : null,
        ]
          .filter(Boolean)
          .join(", ") || "Unknown"
      }`,
      contact.defaultCurrency
        ? `Default Currency: ${contact.defaultCurrency}`
        : null,
      contact.updatedDateUTC ? `Last Updated: ${contact.updatedDateUTC}` : null,
      `Status: ${contact.contactStatus || "Unknown"}`,
      ...formatAddressLines(contact),
      ...formatPhoneLines(contact),
      ...contactPersonLines,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  },
);

export default GetContactTool;
