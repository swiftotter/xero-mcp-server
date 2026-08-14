import { LineItem } from "xero-node";
import { AccountNameMap, formatAccountRef } from "./account-names.js";

export const formatLineItem = (
  lineItem: LineItem,
  accountNames: AccountNameMap,
): string => {
  return [
    `Item: ${lineItem.item ? JSON.stringify(lineItem.item) : ""}`,
    `Item Code: ${lineItem.itemCode}`,
    `Description: ${lineItem.description}`,
    `Quantity: ${lineItem.quantity}`,
    `Unit Amount: ${lineItem.unitAmount}`,
    `Account: ${formatAccountRef(lineItem.accountCode, accountNames)}`,
    `Tax Type: ${lineItem.taxType}`,
    `Tracking: ${lineItem.tracking && lineItem.tracking.length > 0 ? JSON.stringify(lineItem.tracking) : ""}`,
    `Line Amount: ${lineItem.lineAmount}`,
  ].join("\n");
};
