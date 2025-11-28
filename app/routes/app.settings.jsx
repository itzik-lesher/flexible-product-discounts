// app/routes/app.settings.jsx
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import styles from "./_index/styles.module.css";
import { useLoaderData, useFetcher } from "react-router";
import { json } from "@remix-run/node";
import db from "../db.server.js";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const settings = await db.formSettings.findFirst({
      where: {
        shop: shop,
      },
      include: {
        products: true,
        collections: true,
        types: true,
        tags: true,
      },
    });

    if (!settings) {
      return json({
        //fieldOne: "",
        //fieldTwo: "",
        products: [],
        collections: [],
        types: [],
        tags: [],
      });
    }

    console.log("Settings--------------->", settings);
    return json(settings);
  } catch (error) {
    console.error("Loader error:", error);
    return json({
      //fieldOne: "",
      //fieldTwo: "",
      products: [],
      collections: [],
      types: [],
      tags: [],
    });
  }
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "submitForm") {
    //const fieldOne = formData.get("fieldOne");
    //const fieldTwo = formData.get("fieldTwo");
    const productsJson = formData.get("selectedProducts");
    const collectionsJson = formData.get("selectedCollections");
    const typesJson = formData.get("selectedTypes");
    const tagsJson = formData.get("selectedTags");

    const selectedProducts = productsJson ? JSON.parse(productsJson) : [];
    const selectedCollections = collectionsJson
      ? JSON.parse(collectionsJson)
      : [];
    const selectedTypes = typesJson ? JSON.parse(typesJson) : [];
    const selectedTags = tagsJson ? JSON.parse(tagsJson) : [];

    try {
      // STEP 1: Check if discount ID exists in database
      const existingSettings = await db.formSettings.findFirst({
        where: {
          shop: shop,
        },
      });

      if (!existingSettings?.shopifyDiscountId) {
        return json(
          { error: "Discount not configured. Please run setup first." },
          { status: 400 },
        );
      }

      const DISCOUNT_ID = existingSettings.shopifyDiscountId;

      // STEP 2: Save to database (for UI display)
      let result;
      if (existingSettings) {
        await db.selectedProduct.deleteMany({
          where: { formSettingsId: existingSettings.id },
        });
        await db.selectedCollection.deleteMany({
          where: { formSettingsId: existingSettings.id },
        });
        await db.selectedType.deleteMany({
          where: { formSettingsId: existingSettings.id },
        });
        await db.selectedTag.deleteMany({
          where: { formSettingsId: existingSettings.id },
        });

        result = await db.formSettings.update({
          where: { id: existingSettings.id },
          data: {
            //fieldOne,
            // fieldTwo,
            products: {
              create: selectedProducts.map((product) => ({
                shopifyProductId: product.id,
                productTitle: product.title,
                discountPercentage: product.discountPercentage,
              })),
            },
            collections: {
              create: selectedCollections.map((collection) => ({
                collectionId: collection.id,
                collectionTitle: collection.title,
                productCount: collection.productCount,
                discountPercentage: collection.discountPercentage,
              })),
            },
            types: {
              create: selectedTypes.map((type) => ({
                typeName: type.type,
                productCount: type.productCount,
                discountPercentage: type.discountPercentage,
              })),
            },
            tags: {
              create: selectedTags.map((tag) => ({
                tagName: tag.tag,
                productCount: tag.productCount,
                discountPercentage: tag.discountPercentage,
              })),
            },
          },
          include: {
            products: true,
            collections: true,
            types: true,
            tags: true,
          },
        });
        console.log("Database record updated:", result);
      } else {
        return json(
          { error: "Settings not found in database" },
          { status: 400 },
        );
      }

      // STEP 3: Expand collections and tags into individual products for the metafield
      const expandedProducts = [
        ...selectedProducts.map((p) => ({
          shopifyProductId: p.id,
          discountPercentage: p.discountPercentage,
        })),
      ];

      // Create a Set of product IDs that already have individual discounts (highest priority)
      const individualProductIds = new Set(selectedProducts.map((p) => p.id));

      // Expand collections into products
      for (const collection of selectedCollections) {
        if (!collection.discountPercentage) continue; // Skip if no discount set

        try {
          // Fetch products in this collection from Shopify
          const collectionQuery = `
            query GetCollectionProducts($id: ID!) {
              collection(id: $id) {
                products(first: 250) {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          `;

          const collectionResponse = await admin.graphql(collectionQuery, {
            variables: {
              id: collection.id,
            },
          });

          const collectionData = await collectionResponse.json();
          const collectionProducts =
            collectionData.data?.collection?.products?.edges || [];

          // Add each product from the collection (but don't override individual product discounts)
          collectionProducts.forEach((edge) => {
            const productId = edge.node.id;
            // Only add if not already in individual products (individual products take priority)
            if (!individualProductIds.has(productId)) {
              // Also check if not already added from another collection
              const alreadyExists = expandedProducts.some(
                (p) => p.shopifyProductId === productId,
              );
              if (!alreadyExists) {
                expandedProducts.push({
                  shopifyProductId: productId,
                  discountPercentage: collection.discountPercentage,
                });
              }
            }
          });

          console.log(
            `Expanded collection ${collection.title}: processed ${collectionProducts.length} products`,
          );
        } catch (error) {
          console.error(
            `Error fetching products for collection ${collection.id}:`,
            error,
          );
          // Continue with other collections even if one fails
        }
      }

      // Expand tags into products
      for (const tag of selectedTags) {
        if (!tag.discountPercentage) continue; // Skip if no discount set

        try {
          // Fetch products with this tag from Shopify
          const tagQuery = `
            query GetProductsByTag($query: String!) {
              products(first: 250, query: $query) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          `;

          const tagResponse = await admin.graphql(tagQuery, {
            variables: {
              query: `tag:${tag.tag}`,
            },
          });

          const tagData = await tagResponse.json();
          const tagProducts = tagData.data?.products?.edges || [];

          // Add each product with this tag (respecting priority)
          tagProducts.forEach((edge) => {
            const productId = edge.node.id;
            // Only add if not already in individual products or collections
            if (!individualProductIds.has(productId)) {
              const alreadyExists = expandedProducts.some(
                (p) => p.shopifyProductId === productId,
              );
              if (!alreadyExists) {
                expandedProducts.push({
                  shopifyProductId: productId,
                  discountPercentage: tag.discountPercentage,
                });
              }
            }
          });

          console.log(
            `Expanded tag ${tag.tag}: processed ${tagProducts.length} products`,
          );
        } catch (error) {
          console.error(`Error fetching products for tag ${tag.tag}:`, error);
          // Continue with other tags even if one fails
        }
      }

      // STEP 4: Prepare configuration for the discount function
      const discountConfig = {
        products: expandedProducts,
        types: selectedTypes.map((t) => ({
          typeName: t.type,
          discountPercentage: t.discountPercentage,
        })),
      };

      // Check if all arrays are empty
      const hasNoDiscounts =
        expandedProducts.length === 0 && selectedTypes.length === 0;

      console.log("Discount configuration to save:");
      console.log(`  - Individual products: ${selectedProducts.length}`);
      console.log(
        `  - Expanded from collections: ${selectedCollections.length} collections`,
      );
      console.log(`  - Expanded from tags: ${selectedTags.length} tags`);
      console.log(
        `  - Total products in metafield: ${expandedProducts.length}`,
      );
      console.log(`  - Types: ${selectedTypes.length}`);

      // STEP 5: Update the metafield on the discount
      const metafieldMutation = `
  mutation UpdateDiscountMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

      const metafieldResponse = await admin.graphql(metafieldMutation, {
        variables: {
          metafields: [
            {
              ownerId: DISCOUNT_ID,
              namespace: "$app:discount-function",
              key: "function-configuration",
              type: "json",
              // If no discounts, save empty structure
              value: hasNoDiscounts
                ? JSON.stringify({ products: [], types: [] })
                : JSON.stringify(discountConfig),
            },
          ],
        },
      });

      const metafieldResult = await metafieldResponse.json();

      console.log(
        "Metafield update result:",
        JSON.stringify(metafieldResult, null, 2),
      );

      if (metafieldResult.data?.metafieldsSet?.userErrors?.length > 0) {
        console.error(
          "Metafield errors:",
          metafieldResult.data.metafieldsSet.userErrors,
        );
        return json(
          {
            error: "Failed to update discount configuration",
            details: metafieldResult.data.metafieldsSet.userErrors,
          },
          { status: 500 },
        );
      }

      console.log("✓ Metafield updated successfully");

      return json({
        success: true,
        data: result,
        message: hasNoDiscounts
          ? "All discounts cleared successfully!"
          : "Settings and discount configuration saved successfully!",
      });
      
    } catch (error) {
      console.error("Action error:", error);
      return json(
        { error: `Failed to save settings: ${error.message}` },
        { status: 500 },
      );
    }
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function Settings() {
  let settings = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  // Add this state at the top with other useState declarations
  const [setupStatus, setSetupStatus] = useState(null);

  const [selectedProducts, setSelectedProducts] = useState([]);
  const [selectedCollections, setSelectedCollections] = useState([]);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [selectedTags, setSelectedTags] = useState([]);
  //const [formData, setFormData] = useState(settings);
  const [selectedOption, setSelectedOption] = useState("collection");
  const [isLoading, setIsLoading] = useState(false);
  const [showTypeModal, setShowTypeModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [availableTypes, setAvailableTypes] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  const [tempSelectedTypes, setTempSelectedTypes] = useState([]);
  const [tempSelectedTags, setTempSelectedTags] = useState([]);
  const [typeSearchQuery, setTypeSearchQuery] = useState("");
  const [tagSearchQuery, setTagSearchQuery] = useState("");
  const [expandedCollections, setExpandedCollections] = useState({});
  const [expandedTypes, setExpandedTypes] = useState({});
  const [expandedTags, setExpandedTags] = useState({});

  // Discount percentage options
  const discountOptions = [10, 20, 30, 40, 50];

  useEffect(() => {
    if (settings.products && settings.products.length > 0) {
      setSelectedProducts(
        settings.products.map((p) => ({
          id: p.shopifyProductId,
          title: p.productTitle,
          discountPercentage: p.discountPercentage,
        })),
      );
    }

    if (settings.collections && settings.collections.length > 0) {
      const collectionsToRestore = settings.collections.map((c) => ({
        id: c.collectionId,
        title: c.collectionTitle,
        productCount: c.productCount,
        discountPercentage: c.discountPercentage,
        products: [],
      }));
      setSelectedCollections(collectionsToRestore);
      restoreCollectionProducts(collectionsToRestore);
    }

    if (settings.types && settings.types.length > 0) {
      const typesToRestore = settings.types.map((t) => ({
        id: `type-${t.typeName}`,
        type: t.typeName,
        productCount: t.productCount,
        discountPercentage: t.discountPercentage,
        products: [],
      }));
      setSelectedTypes(typesToRestore);
      restoreTypeProducts(typesToRestore);
    }

    if (settings.tags && settings.tags.length > 0) {
      const tagsToRestore = settings.tags.map((t) => ({
        id: `tag-${t.tagName}`,
        tag: t.tagName,
        productCount: t.productCount,
        discountPercentage: t.discountPercentage,
        products: [],
      }));
      setSelectedTags(tagsToRestore);
      restoreTagProducts(tagsToRestore);
    }
  }, [settings]);

  const restoreCollectionProducts = async (collections) => {
    const updatedCollections = [];
    for (const col of collections) {
      try {
        const response = await fetch(
          `/api/products?filterType=collection&value=${encodeURIComponent(col.id)}`,
        );
        if (response.ok) {
          const data = await response.json();
          updatedCollections.push({
            ...col,
            products: data.products || [],
          });
        } else {
          updatedCollections.push(col);
        }
      } catch (err) {
        console.error(`Error restoring collection ${col.id}:`, err);
        updatedCollections.push(col);
      }
    }
    setSelectedCollections(updatedCollections);
  };

  const restoreTypeProducts = async (types) => {
    const updatedTypes = [];
    for (const type of types) {
      try {
        const response = await fetch(
          `/api/products?filterType=type&value=${encodeURIComponent(type.type)}`,
        );
        if (response.ok) {
          const data = await response.json();
          updatedTypes.push({
            ...type,
            products: data.products || [],
          });
        } else {
          updatedTypes.push(type);
        }
      } catch (err) {
        console.error(`Error restoring type ${type.type}:`, err);
        updatedTypes.push(type);
      }
    }
    setSelectedTypes(updatedTypes);
  };

  const restoreTagProducts = async (tags) => {
    const updatedTags = [];
    for (const tag of tags) {
      try {
        const response = await fetch(
          `/api/products?filterType=tag&value=${encodeURIComponent(tag.tag)}`,
        );
        if (response.ok) {
          const data = await response.json();
          updatedTags.push({
            ...tag,
            products: data.products || [],
          });
        } else {
          updatedTags.push(tag);
        }
      } catch (err) {
        console.error(`Error restoring tag ${tag.tag}:`, err);
        updatedTags.push(tag);
      }
    }
    setSelectedTags(updatedTags);
  };
  /*
  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };
 */
  // Handler for discount percentage changes
  const handleDiscountChange = (type, itemId, value) => {
    const discount = value === "" ? null : parseInt(value);

    switch (type) {
      case "product":
        setSelectedProducts((prev) =>
          prev.map((p) =>
            p.id === itemId ? { ...p, discountPercentage: discount } : p,
          ),
        );
        break;
      case "collection":
        setSelectedCollections((prev) =>
          prev.map((c) =>
            c.id === itemId ? { ...c, discountPercentage: discount } : c,
          ),
        );
        break;
      case "type":
        setSelectedTypes((prev) =>
          prev.map((t) =>
            t.id === itemId ? { ...t, discountPercentage: discount } : t,
          ),
        );
        break;
      case "tag":
        setSelectedTags((prev) =>
          prev.map((t) =>
            t.id === itemId ? { ...t, discountPercentage: discount } : t,
          ),
        );
        break;
    }
  };

  const productPickerHandler = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
      });
      if (selected && selected.length > 0) {
        const newProducts = selected.map((p) => ({
          ...p,
          discountPercentage: null, // Initialize with no discount
        }));
        const uniqueProducts = [
          ...new Map(
            [...selectedProducts, ...newProducts].map((p) => [p.id, p]),
          ).values(),
        ];
        setSelectedProducts(uniqueProducts);
      }
    } catch (error) {
      console.error("Product picker error:", error);
    }
  };

  const handleBulkPicker = async (filterType) => {
    setIsLoading(true);
    try {
      switch (filterType) {
        case "collection": {
          const selectedCollectionsPicker = await shopify.resourcePicker({
            type: "collection",
            multiple: true,
          });
          if (
            selectedCollectionsPicker &&
            selectedCollectionsPicker.length > 0
          ) {
            const newCollections = [];
            for (const col of selectedCollectionsPicker) {
              try {
                const response = await fetch(
                  `/api/products?filterType=collection&value=${encodeURIComponent(col.id)}`,
                );
                if (!response.ok) {
                  console.error(
                    `Failed to fetch products for collection ${col.id}`,
                  );
                  continue;
                }
                const data = await response.json();
                const productCount = data.products ? data.products.length : 0;
                newCollections.push({
                  id: col.id,
                  title: col.title,
                  productCount: productCount,
                  discountPercentage: null, // Initialize with no discount
                  products: data.products || [],
                });
              } catch (err) {
                console.error(`Error fetching collection ${col.id}:`, err);
              }
            }
            if (newCollections.length > 0) {
              const uniqueCollections = [
                ...new Map(
                  [...selectedCollections, ...newCollections].map((c) => [
                    c.id,
                    c,
                  ]),
                ).values(),
              ];
              setSelectedCollections(uniqueCollections);
            }
          }
          break;
        }

        case "type": {
          try {
            const typesResponse = await fetch(`/api/product-types`);
            if (!typesResponse.ok) {
              alert("Failed to fetch product types.");
              break;
            }
            const typesData = await typesResponse.json();
            if (!typesData.types || typesData.types.length === 0) {
              alert("No product types found in your store.");
              break;
            }
            setAvailableTypes(typesData.types);
            setTempSelectedTypes([]);
            setTypeSearchQuery("");
            setShowTypeModal(true);
          } catch (err) {
            console.error("Error fetching product types:", err);
            alert("Error fetching product types.");
          }
          break;
        }

        case "tag": {
          try {
            const tagsResponse = await fetch(`/api/product-tags`);
            if (!tagsResponse.ok) {
              alert("Failed to fetch product tags.");
              break;
            }
            const tagsData = await tagsResponse.json();
            if (!tagsData.tags || tagsData.tags.length === 0) {
              alert("No product tags found in your store.");
              break;
            }
            setAvailableTags(tagsData.tags);
            setTempSelectedTags([]);
            setTagSearchQuery("");
            setShowTagModal(true);
          } catch (err) {
            console.error("Error fetching product tags:", err);
            alert("Error fetching product tags.");
          }
          break;
        }

        default:
          console.warn("Unknown filter type:", filterType);
      }
    } catch (error) {
      console.error("Bulk picker error:", error);
      alert("An error occurred while adding products.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleTypeModalConfirm = async () => {
    if (tempSelectedTypes.length === 0) {
      setShowTypeModal(false);
      return;
    }

    setIsLoading(true);
    const newTypes = [];
    for (const selectedType of tempSelectedTypes) {
      try {
        const response = await fetch(
          `/api/products?filterType=type&value=${encodeURIComponent(selectedType)}`,
        );
        if (!response.ok) {
          console.error(`Failed to fetch products for type ${selectedType}`);
          continue;
        }
        const data = await response.json();
        if (data.products && data.products.length > 0) {
          const isDuplicate = selectedTypes.some(
            (t) => t.type === selectedType,
          );
          if (!isDuplicate) {
            newTypes.push({
              id: `type-${selectedType}`,
              type: selectedType,
              productCount: data.products.length,
              discountPercentage: null, // Initialize with no discount
              products: data.products,
            });
          }
        }
      } catch (err) {
        console.error(`Error fetching products for type ${selectedType}:`, err);
      }
    }
    if (newTypes.length > 0) {
      setSelectedTypes((prev) => [...prev, ...newTypes]);
    }
    setIsLoading(false);
    setShowTypeModal(false);
  };

  const handleTagModalConfirm = async () => {
    if (tempSelectedTags.length === 0) {
      setShowTagModal(false);
      return;
    }

    setIsLoading(true);
    const newTags = [];
    for (const selectedTag of tempSelectedTags) {
      try {
        const response = await fetch(
          `/api/products?filterType=tag&value=${encodeURIComponent(selectedTag)}`,
        );
        if (!response.ok) {
          console.error(`Failed to fetch products for tag ${selectedTag}`);
          continue;
        }
        const data = await response.json();
        if (data.products && data.products.length > 0) {
          const isDuplicate = selectedTags.some((t) => t.tag === selectedTag);
          if (!isDuplicate) {
            newTags.push({
              id: `tag-${selectedTag}`,
              tag: selectedTag,
              productCount: data.products.length,
              discountPercentage: null, // Initialize with no discount
              products: data.products,
            });
          }
        }
      } catch (err) {
        console.error(`Error fetching products for tag ${selectedTag}:`, err);
      }
    }
    if (newTags.length > 0) {
      setSelectedTags((prev) => [...prev, ...newTags]);
    }
    setIsLoading(false);
    setShowTagModal(false);
  };

  const toggleTypeSelection = (type) => {
    setTempSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const toggleTagSelection = (tag) => {
    setTempSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const removeProduct = (productId) => {
    setSelectedProducts((prev) =>
      prev.filter((product) => product.id !== productId),
    );
  };

  const removeCollection = (collectionId) => {
    setSelectedCollections((prev) =>
      prev.filter((collection) => collection.id !== collectionId),
    );
  };

  const removeType = (typeId) => {
    setSelectedTypes((prev) => prev.filter((type) => type.id !== typeId));
  };

  const removeTag = (tagId) => {
    setSelectedTags((prev) => prev.filter((tag) => tag.id !== tagId));
  };

  const toggleCollectionExpand = (collectionId) => {
    setExpandedCollections((prev) => ({
      ...prev,
      [collectionId]: !prev[collectionId],
    }));
  };

  const toggleTypeExpand = (typeId) => {
    setExpandedTypes((prev) => ({
      ...prev,
      [typeId]: !prev[typeId],
    }));
  };

  const toggleTagExpand = (tagId) => {
    setExpandedTags((prev) => ({
      ...prev,
      [tagId]: !prev[tagId],
    }));
  };

  const handleFormSubmit = (e) => {
    const form = e.currentTarget;

    let productsInput = form.querySelector('input[name="selectedProducts"]');
    if (!productsInput) {
      productsInput = document.createElement("input");
      productsInput.type = "hidden";
      productsInput.name = "selectedProducts";
      form.appendChild(productsInput);
    }
    productsInput.value = JSON.stringify(selectedProducts);

    let collectionsInput = form.querySelector(
      'input[name="selectedCollections"]',
    );
    if (!collectionsInput) {
      collectionsInput = document.createElement("input");
      collectionsInput.type = "hidden";
      collectionsInput.name = "selectedCollections";
      form.appendChild(collectionsInput);
    }
    collectionsInput.value = JSON.stringify(selectedCollections);

    let typesInput = form.querySelector('input[name="selectedTypes"]');
    if (!typesInput) {
      typesInput = document.createElement("input");
      typesInput.type = "hidden";
      typesInput.name = "selectedTypes";
      form.appendChild(typesInput);
    }
    typesInput.value = JSON.stringify(selectedTypes);

    let tagsInput = form.querySelector('input[name="selectedTags"]');
    if (!tagsInput) {
      tagsInput = document.createElement("input");
      tagsInput.type = "hidden";
      tagsInput.name = "selectedTags";
      form.appendChild(tagsInput);
    }
    tagsInput.value = JSON.stringify(selectedTags);
  };

  const getTotalProductCount = () => {
    const allProducts = [
      ...selectedProducts,
      ...selectedCollections.flatMap((c) => c.products),
      ...selectedTypes.flatMap((t) => t.products),
      ...selectedTags.flatMap((t) => t.products),
    ];
    const uniqueProducts = new Map(allProducts.map((p) => [p.id, p]));
    return uniqueProducts.size;
  };

  const filteredTypes = availableTypes.filter((type) =>
    type.toLowerCase().includes(typeSearchQuery.toLowerCase()),
  );

  const filteredTags = availableTags.filter((tag) =>
    tag.toLowerCase().includes(tagSearchQuery.toLowerCase()),
  );

  // Add this function before the return statement
  const handleSetupDiscount = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/app/setup-discount", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const result = await response.json();

      if (result.success) {
        setSetupStatus({ type: "success", message: result.message });
      } else {
        setSetupStatus({ type: "error", message: result.error });
      }
    } catch (error) {
      setSetupStatus({ type: "error", message: "Failed to setup discount" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <s-page heading="Settings">
      <s-section heading="Setup">
        <div
          style={{
            marginBottom: "24px",
            padding: "16px",
            border: "1px solid #e1e3e5",
            borderRadius: "8px",
            backgroundColor: "#fafafa",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Initial Setup</h3>
          <p style={{ fontSize: "14px", color: "#666" }}>
            Click the button below to create the discount function in Shopify.
            This only needs to be done once.
          </p>
          <button
            onClick={handleSetupDiscount}
            disabled={isLoading}
            style={{
              padding: "10px 16px",
              backgroundColor: isLoading ? "#ccc" : "#008060",
              color: "white",
              border: "none",
              borderRadius: "6px",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontSize: "14px",
              fontWeight: 500,
            }}
          >
            {isLoading ? "Setting up..." : "Setup Discount Function"}
          </button>

          {setupStatus && (
            <div
              style={{
                marginTop: "12px",
                padding: "12px",
                borderRadius: "6px",
                backgroundColor:
                  setupStatus.type === "success" ? "#d4edda" : "#f8d7da",
                color: setupStatus.type === "success" ? "#155724" : "#721c24",
                fontSize: "14px",
              }}
            >
              {setupStatus.message}
            </div>
          )}
        </div>
      </s-section>

      <s-section >
        <div
          style={{
            marginBottom: "24px",
            padding: "20px",
            border: "2px solid #008060",
            borderRadius: "8px",
            backgroundColor: "#f0fdf4",
          }}
        >
          <h3 style={{ marginTop: 0, color: "#008060" }}>Quick Start Guide</h3>
          <ul
            style={{
              fontSize: "16px",
              lineHeight: "2",
              color: "#333",
              paddingLeft: "24px",
            }}
          >
            <li>
              <strong>Select products</strong> - Choose individual products,
              collections, types, or tags
            </li>
            <li>
              <strong>Set discount percentage</strong> - Pick 10%, 20%, 30%,
              40%, or 50% for each selection
            </li>
            <li>
              <strong>Press Submit button</strong> - Your discounts will be
              active immediately!
            </li>
          </ul>
        </div>

        <div
          style={{
            marginTop: "24px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={productPickerHandler}
            disabled={isLoading}
            style={{
              padding: "16px 24px",
              backgroundColor: isLoading ? "#ccc" : "#008060",
              color: "white",
              border: "none",
              borderRadius: "8px",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontSize: "16px",
              fontWeight: 600,
            }}
          >
            Add Individual Products
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={() => handleBulkPicker(selectedOption)}
              disabled={isLoading}
              style={{
                padding: "16px 24px",
                backgroundColor: isLoading ? "#ccc" : "#005c3c",
                color: "white",
                border: "none",
                borderRadius: "8px",
                cursor: isLoading ? "not-allowed" : "pointer",
                fontSize: "16px",
                fontWeight: 600,
              }}
            >
              {isLoading ? "Loading..." : "Add by Filter"}
            </button>
            <select
              value={selectedOption}
              onChange={(e) => setSelectedOption(e.target.value)}
              disabled={isLoading}
              style={{
                padding: "14px",
                borderRadius: "8px",
                border: "2px solid #008060",
                fontSize: "16px",
                cursor: isLoading ? "not-allowed" : "pointer",
                fontWeight: 500,
              }}
            >
              <option value="collection">Collection</option>
              <option value="type">Type</option>
              <option value="tag">Tag</option>
            </select>
          </div>
        </div>

        {/* Type Modal - Keep existing */}
        {showTypeModal && (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}
            onClick={() => setShowTypeModal(false)}
          >
            {/* KEEP YOUR EXISTING TYPE MODAL CODE */}
          </div>
        )}

        {/* Tag Modal - Keep existing */}
        {showTagModal && (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}
            onClick={() => setShowTagModal(false)}
          >
            {/* KEEP YOUR EXISTING TAG MODAL CODE */}
          </div>
        )}

        {/* SELECTED ITEMS SECTION - THIS WAS MISSING! */}
        {/* Selected Items Display - Only show if there are items */}
        {(selectedProducts.length > 0 ||
          selectedCollections.length > 0 ||
          selectedTypes.length > 0 ||
          selectedTags.length > 0) && (
          <div
            style={{
              marginTop: "20px",
              padding: "16px",
              border: "1px solid #e1e3e5",
              borderRadius: "8px",
              backgroundColor: "#fafafa",
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: "12px" }}>
              Selected Items (Total unique products: {getTotalProductCount()}):
            </h3>

            {selectedCollections.length > 0 && (
              <div style={{ marginBottom: "16px" }}>
                <h4
                  style={{
                    marginTop: 0,
                    marginBottom: "8px",
                    fontSize: "14px",
                    color: "#666",
                  }}
                >
                  Collections:
                </h4>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {selectedCollections.map((collection) => (
                    <li key={collection.id} style={{ marginBottom: "8px" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px",
                          backgroundColor: "#e8f5e9",
                          border: "1px solid #a5d6a7",
                          borderRadius: "6px",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <button
                              onClick={() =>
                                toggleCollectionExpand(collection.id)
                              }
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                fontSize: "16px",
                                padding: "0",
                                color: "#333",
                              }}
                            >
                              {expandedCollections[collection.id] ? "▼" : "▶"}
                            </button>
                            <strong>📁 {collection.title}</strong>
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#666",
                              marginLeft: "24px",
                            }}
                          >
                            {collection.productCount} products
                          </div>
                        </div>

                        <select
                          value={collection.discountPercentage || ""}
                          onChange={(e) =>
                            handleDiscountChange(
                              "collection",
                              collection.id,
                              e.target.value,
                            )
                          }
                          style={{
                            padding: "8px 12px",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            fontSize: "13px",
                            marginRight: "8px",
                            cursor: "pointer",
                            backgroundColor: "white",
                          }}
                        >
                          <option value="">Select %</option>
                          {discountOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}%
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => removeCollection(collection.id)}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#d82c0d",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: 500,
                          }}
                        >
                          Delete
                        </button>
                      </div>
                      {expandedCollections[collection.id] &&
                        collection.products &&
                        collection.products.length > 0 && (
                          <div
                            style={{
                              marginTop: "4px",
                              marginLeft: "24px",
                              padding: "12px",
                              backgroundColor: "#f1f8f1",
                              border: "1px solid #c8e6c9",
                              borderRadius: "6px",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "12px",
                                fontWeight: 600,
                                marginBottom: "8px",
                                color: "#666",
                              }}
                            >
                              Products in this collection:
                            </div>
                            {collection.products.map((product) => (
                              <div
                                key={product.id}
                                style={{
                                  fontSize: "12px",
                                  padding: "4px 0",
                                  color: "#333",
                                }}
                              >
                                • {product.title}
                              </div>
                            ))}
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedTypes.length > 0 && (
              <div style={{ marginBottom: "16px" }}>
                <h4
                  style={{
                    marginTop: 0,
                    marginBottom: "8px",
                    fontSize: "14px",
                    color: "#666",
                  }}
                >
                  Product Types:
                </h4>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {selectedTypes.map((type) => (
                    <li key={type.id} style={{ marginBottom: "8px" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px",
                          backgroundColor: "#e3f2fd",
                          border: "1px solid #90caf9",
                          borderRadius: "6px",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <button
                              onClick={() => toggleTypeExpand(type.id)}
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                fontSize: "16px",
                                padding: "0",
                                color: "#333",
                              }}
                            >
                              {expandedTypes[type.id] ? "▼" : "▶"}
                            </button>
                            <strong>🏷️ Type: {type.type}</strong>
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#666",
                              marginLeft: "24px",
                            }}
                          >
                            {type.productCount} products
                          </div>
                        </div>

                        <select
                          value={type.discountPercentage || ""}
                          onChange={(e) =>
                            handleDiscountChange(
                              "type",
                              type.id,
                              e.target.value,
                            )
                          }
                          style={{
                            padding: "8px 12px",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            fontSize: "13px",
                            marginRight: "8px",
                            cursor: "pointer",
                            backgroundColor: "white",
                          }}
                        >
                          <option value="">Select %</option>
                          {discountOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}%
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => removeType(type.id)}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#d82c0d",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: 500,
                          }}
                        >
                          Delete
                        </button>
                      </div>
                      {expandedTypes[type.id] &&
                        type.products &&
                        type.products.length > 0 && (
                          <div
                            style={{
                              marginTop: "4px",
                              marginLeft: "24px",
                              padding: "12px",
                              backgroundColor: "#e8f4fd",
                              border: "1px solid #bbdefb",
                              borderRadius: "6px",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "12px",
                                fontWeight: 600,
                                marginBottom: "8px",
                                color: "#666",
                              }}
                            >
                              Products with this type:
                            </div>
                            {type.products.map((product) => (
                              <div
                                key={product.id}
                                style={{
                                  fontSize: "12px",
                                  padding: "4px 0",
                                  color: "#333",
                                }}
                              >
                                • {product.title}
                              </div>
                            ))}
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedTags.length > 0 && (
              <div style={{ marginBottom: "16px" }}>
                <h4
                  style={{
                    marginTop: 0,
                    marginBottom: "8px",
                    fontSize: "14px",
                    color: "#666",
                  }}
                >
                  Product Tags:
                </h4>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {selectedTags.map((tag) => (
                    <li key={tag.id} style={{ marginBottom: "8px" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px",
                          backgroundColor: "#fff3e0",
                          border: "1px solid #ffb74d",
                          borderRadius: "6px",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <button
                              onClick={() => toggleTagExpand(tag.id)}
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                fontSize: "16px",
                                padding: "0",
                                color: "#333",
                              }}
                            >
                              {expandedTags[tag.id] ? "▼" : "▶"}
                            </button>
                            <strong>🔖 Tag: {tag.tag}</strong>
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#666",
                              marginLeft: "24px",
                            }}
                          >
                            {tag.productCount} products
                          </div>
                        </div>

                        <select
                          value={tag.discountPercentage || ""}
                          onChange={(e) =>
                            handleDiscountChange("tag", tag.id, e.target.value)
                          }
                          style={{
                            padding: "8px 12px",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            fontSize: "13px",
                            marginRight: "8px",
                            cursor: "pointer",
                            backgroundColor: "white",
                          }}
                        >
                          <option value="">Select %</option>
                          {discountOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}%
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => removeTag(tag.id)}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#d82c0d",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: 500,
                          }}
                        >
                          Delete
                        </button>
                      </div>
                      {expandedTags[tag.id] &&
                        tag.products &&
                        tag.products.length > 0 && (
                          <div
                            style={{
                              marginTop: "4px",
                              marginLeft: "24px",
                              padding: "12px",
                              backgroundColor: "#fff8e1",
                              border: "1px solid #ffe082",
                              borderRadius: "6px",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "12px",
                                fontWeight: 600,
                                marginBottom: "8px",
                                color: "#666",
                              }}
                            >
                              Products with this tag:
                            </div>
                            {tag.products.map((product) => (
                              <div
                                key={product.id}
                                style={{
                                  fontSize: "12px",
                                  padding: "4px 0",
                                  color: "#333",
                                }}
                              >
                                • {product.title}
                              </div>
                            ))}
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedProducts.length > 0 && (
              <div>
                <h4
                  style={{
                    marginTop: 0,
                    marginBottom: "8px",
                    fontSize: "14px",
                    color: "#666",
                  }}
                >
                  Individual Products:
                </h4>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {selectedProducts.map((product) => (
                    <li
                      key={product.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "12px",
                        marginBottom: "8px",
                        backgroundColor: "white",
                        border: "1px solid #ccc",
                        borderRadius: "6px",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <strong>{product.title}</strong>
                        <div style={{ fontSize: "12px", color: "#666" }}>
                          ID: {product.id}
                        </div>
                      </div>

                      <select
                        value={product.discountPercentage || ""}
                        onChange={(e) =>
                          handleDiscountChange(
                            "product",
                            product.id,
                            e.target.value,
                          )
                        }
                        style={{
                          padding: "8px 12px",
                          border: "1px solid #ccc",
                          borderRadius: "4px",
                          fontSize: "13px",
                          marginRight: "8px",
                          cursor: "pointer",
                          backgroundColor: "white",
                        }}
                      >
                        <option value="">Select %</option>
                        {discountOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}%
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() => removeProduct(product.id)}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#d82c0d",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontWeight: 500,
                        }}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Submit Button - ALWAYS VISIBLE */}
        <div style={{ marginTop: "24px", textAlign: "center" }}>
          <fetcher.Form method="post" onSubmit={handleFormSubmit}>
            <input type="hidden" name="_action" value="submitForm" />

            {selectedProducts.length === 0 &&
              selectedCollections.length === 0 &&
              selectedTypes.length === 0 &&
              selectedTags.length === 0 && (
                <div
                  style={{
                    padding: "20px",
                    backgroundColor: "#fff3cd",
                    border: "2px solid #ffc107",
                    borderRadius: "8px",
                    marginBottom: "16px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      marginBottom: "12px",
                    }}
                  >
                    <span style={{ fontSize: "24px", marginRight: "12px" }}>
                      ⚠️
                    </span>
                    <div>
                      <strong style={{ fontSize: "16px", color: "#856404" }}>
                        No discounts selected
                      </strong>
                      <p
                        style={{
                          margin: "4px 0 0 0",
                          color: "#856404",
                          fontSize: "14px",
                        }}
                      >
                        Clicking the button below will clear all active
                        discounts immediately.
                      </p>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: "13px",
                      padding: "14px",
                      backgroundColor: "#fffbf0",
                      border: "1px solid #ffe8a1",
                      borderRadius: "6px",
                      color: "#856404",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: "6px" }}>
                      📌 Important Note:
                    </strong>
                    <div style={{ lineHeight: "1.6" }}>
                      Customers who{" "}
                      <strong>already have items in their cart</strong> will
                      keep their existing discounts until they:
                      <ul
                        style={{
                          marginTop: "8px",
                          marginBottom: 0,
                          paddingLeft: "20px",
                          lineHeight: "1.8",
                        }}
                      >
                        <li>
                          Remove all items from their cart and re-add them
                        </li>
                        <li>
                          Complete their purchase and start a new shopping
                          session
                        </li>
                      </ul>
                    </div>
                    <div
                      style={{
                        marginTop: "10px",
                        padding: "8px",
                        backgroundColor: "#fff8e1",
                        borderRadius: "4px",
                        fontSize: "12px",
                      }}
                    >
                      💡 <strong>Tip:</strong> New customers adding items after
                      you clear discounts will see the correct (no discount)
                      prices immediately.
                    </div>
                  </div>
                </div>
              )}

            <button
              type="submit"
              disabled={fetcher.state === "submitting"}
              style={{
                padding: "20px 60px",
                backgroundColor:
                  fetcher.state === "submitting" ? "#ccc" : "#008060",
                color: "white",
                border: "none",
                borderRadius: "10px",
                cursor:
                  fetcher.state === "submitting" ? "not-allowed" : "pointer",
                fontSize: "20px",
                fontWeight: 700,
                boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
                transition: "all 0.2s",
              }}
              onMouseOver={(e) => {
                if (fetcher.state !== "submitting") {
                  e.currentTarget.style.backgroundColor = "#006d4a";
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.boxShadow =
                    "0 6px 8px rgba(0,0,0,0.15)";
                }
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.backgroundColor = "#008060";
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 4px 6px rgba(0,0,0,0.1)";
              }}
            >
              {fetcher.state === "submitting"
                ? "Saving..."
                : selectedProducts.length === 0 &&
                    selectedCollections.length === 0 &&
                    selectedTypes.length === 0 &&
                    selectedTags.length === 0
                  ? "🗑️ Clear All Discounts"
                  : "💾 Submit & Activate Discounts"}
            </button>
          </fetcher.Form>

          {fetcher.data?.success && (
            <div
              style={{
                marginTop: "16px",
                color: "#008060",
                fontSize: "16px",
                fontWeight: 600,
              }}
            >
              ✓ {fetcher.data.message}
            </div>
          )}
          {fetcher.data?.error && (
            <div
              style={{
                marginTop: "16px",
                color: "#d82c0d",
                fontSize: "16px",
                fontWeight: 600,
              }}
            >
              ✗ {fetcher.data.error}
            </div>
          )}
        </div>
      </s-section>
      <s-section slot="aside" heading="Resources">
        <s-unordered-list>
          <s-list-item>
            <s-link
              href="https://shopify.dev/docs/apps/design-guidelines/navigation#app-nav"
              target="_blank"
            >
              App nav best practices
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}