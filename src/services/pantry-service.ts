import * as store from "../store.js";

export interface UpdatePantryItemsInput {
  add: string[];
  remove: string[];
}

export interface UpdatePantryItemsResult {
  status: "updated";
  pantry: string[];
}

/** Delegate the complete pantry mutation to the store's locked read-modify-write primitive. */
export async function updatePantryItems(
  input: UpdatePantryItemsInput,
): Promise<UpdatePantryItemsResult> {
  const pantry = await store.updatePantry(input.add, input.remove);
  return { status: "updated", pantry };
}
