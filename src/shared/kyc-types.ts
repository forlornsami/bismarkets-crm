// The document types the portal and app offer. Ids and names match what both
// front ends send and look up (type 3 = identity, 4 = proof of address).
export const KYC_TYPES = {
  identity: {
    type: 3,
    label: "Identity",
    subTypes: [
      { id: 1, name: "ID Card", documents: 2 },
      { id: 2, name: "Passport", documents: 1 },
      { id: 3, name: "Driving License", documents: 2 },
    ],
  },
  address: {
    type: 4,
    label: "Proof of address",
    subTypes: [
      { id: 1, name: "Bank Statement", documents: 1 },
      { id: 2, name: "Utility Bill", documents: 1 },
      { id: 3, name: "Credit Card Statement", documents: 1 },
      { id: 4, name: "ID Card Back", documents: 1 },
    ],
  },
} as const;
