const express = require('express');
const router = express.Router();
const axios = require('axios');

/**
 * Middleware to validate request origin from Shopify store
 */
const validateStoreRequest = (req, res, next) => {
  const origin = req.get('Origin') || req.get('Referer');
  console.log("orifin",req.headers.host)
  // Check if request comes from the authorized source
  let isValidOrigin = false;
  
  if (process.env.NODE_ENV === 'development') {
    isValidOrigin = req.headers.host && (
      req.headers.host.includes(process.env.DEVELOPMENT_URL)
    );
  } else {
    // In production, only allow Shopify store
    isValidOrigin = origin && origin.startsWith(process.env.SHOPIFY_STORE_URL);
  }
  
  if (!isValidOrigin) {
    
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Request not authorized from this store'
    });
  }
  
  req.storeValidation = { isValidated: true };
  next();
};

// Apply validation middleware to all wishlist routes
router.use(validateStoreRequest);

/**
 * Helper function to make Shopify GraphQL API requests
 */
async function makeShopifyGraphQLRequest(query, variables = {}) {
  try {
    const response = await axios.post(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2025-10/graphql.json`,
      {
        query,
        variables
      },
      {
        headers: {
          'X-Shopify-Access-Token': `${process.env.SHOPIFY_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.errors) {
      throw new Error(`GraphQL Error: ${JSON.stringify(response.data.errors)}`);
    }

    return response.data.data;
  } catch (error) {
    console.error('Shopify GraphQL request failed:', error.message);
    throw error;
  }
}

/**
 * Helper function to set the entire wishlist metafield (for removal and clearing)
 * @param {string} customerId - Shopify customer ID
 * @param {Array} wishlistProducts - Array of product objects
 */
async function setWishlistMetafield(customerId, wishlistProducts) {
  try {
    
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
            type
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId: customerId.startsWith('gid://') ? customerId : `gid://shopify/Customer/${customerId}`,
          namespace: 'custom',
          key: 'wishlist_products',
          value: JSON.stringify(wishlistProducts),
          type: 'json'
        }
      ]
    };

    const result = await makeShopifyGraphQLRequest(mutation, variables);
    
    if (result.metafieldsSet.userErrors && result.metafieldsSet.userErrors.length > 0) {
      console.error('GraphQL Errors:', result.metafieldsSet.userErrors);
      throw new Error(`GraphQL Error: ${result.metafieldsSet.userErrors[0].message}`);
    } else {
      console.log('Wishlist metafield set successfully');
    }
    
  } catch (error) {
    console.error('Failed to set wishlist metafield:', error);
    throw error;
  }
}

/**
 * REST API fallback for updating customer metafields
 * @param {string} customerId - Shopify customer ID
 * @param {Array} wishlistProducts - Array of product objects with full details
 */
async function updateCustomerMetafieldREST(customerId, wishlistProducts) {
  try {
    console.log('Using REST API to update metafield...');
    
    // Clean customer ID
    const cleanCustomerId = customerId.replace('gid://shopify/Customer/', '');
    
    // First, try to get existing metafield ID
    const getUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10/customers/${cleanCustomerId}/metafields.json`;
    
    const getResponse = await fetch(getUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      }
    });

    let metafieldId = null;
    if (getResponse.ok) {
      const existingMetafields = await getResponse.json();
      const existingMetafield = existingMetafields.metafields?.find(
        mf => mf.namespace === 'custom' && mf.key === 'wishlist_products'
      );
      metafieldId = existingMetafield?.id;
    }

    let url, method;
    if (metafieldId) {
      // Update existing metafield
      url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10/customers/${cleanCustomerId}/metafields/${metafieldId}.json`;
      method = 'PUT';
    } else {
      // Create new metafield
      url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10/customers/${cleanCustomerId}/metafields.json`;
      method = 'POST';
    }
    
    const response = await fetch(url, {
      method: method,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metafield: {
          namespace: 'custom',
          key: 'wishlist_products',
          value: JSON.stringify(wishlistProducts),
          type: 'json'
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`REST API Error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('REST API metafield update successful:', result);
    
  } catch (error) {
    console.error('REST API metafield update failed:', error);
    throw error;
  }
}

/**
 * Helper function to get product details including handle
 * @param {Array} productIds - Array of product IDs
 */
async function getProductDetails(productIds) {
  try {
    if (!productIds || productIds.length === 0) {
      return [];
    }

    const query = `
      query getProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            handle
            title
          }
        }
      }
    `;

    const variables = {
      ids: productIds.map(id => `gid://shopify/Product/${id}`)
    };

    const result = await makeShopifyGraphQLRequest(query, variables);
    
    return result.nodes.map(product => ({
      id: product.id.replace('gid://shopify/Product/', ''),
      handle: product.handle,
      title: product.title,
    }));

  } catch (error) {
    console.error('Error getting product details:', error);
    // Return basic structure if API fails
    return productIds.map(id => ({
      id,
      handle: null,
      title: `Product ${id}`,
    }));
  }
}
/**
 * Helper function to update customer metafields in Shopify (single JSON array)
 * @param {string} customerId - Shopify customer ID
 * @param {Array} wishlistProducts - Array of product objects with full details
 */
async function updateCustomerMetafield(customerId, wishlistProducts) {
  try {
    
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
            type
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId: customerId.startsWith('gid://') ? customerId : `gid://shopify/Customer/${customerId}`,
          namespace: 'custom',
          key: 'wishlist_products',
          value: JSON.stringify(wishlistProducts),
          type: 'json'
        }
      ]
    };


    const result = await makeShopifyGraphQLRequest(mutation, variables);
    

    if (result.metafieldsSet.userErrors && result.metafieldsSet.userErrors.length > 0) {
      console.error('GraphQL Errors:', result.metafieldsSet.userErrors);
      // Try REST API as fallback
      await updateCustomerMetafieldREST(customerId, wishlistProducts);
    } else {
      console.log('GraphQL metafield update successful');
    }
    
  } catch (error) {
    console.error('GraphQL metafield update failed, trying REST API:', error);
    // Fallback to REST API
    await updateCustomerMetafieldREST(customerId, wishlistProducts);
  }
}
/**
 * Helper function to get customer metafields from Shopify
 * @param {string} customerId - Shopify customer ID
 */
async function getCustomerMetafield(customerId) {
  try {
    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          email
          firstName
          lastName
          metafields(first: 10, namespace: "custom") {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
    `;

    const variables = {
      id: customerId.startsWith('gid://') ? customerId : `gid://shopify/Customer/${customerId}`
    };

    const result = await makeShopifyGraphQLRequest(query, variables);
    
    if (!result.customer) {
      throw new Error(`Customer not found: ${customerId}`);
    }

    // Find the wishlist metafield
    const wishlistMetafield = result.customer.metafields.edges.find(
      edge => edge.node.key === 'wishlist_products' && edge.node.namespace === 'custom'
    );

    if (wishlistMetafield) {
      try {
        const productDetails = JSON.parse(wishlistMetafield.node.value);
        return productDetails;
      } catch (parseError) {
        console.error('Error parsing wishlist metafield:', parseError);
        return [];
      }
    }

    return [];
  } catch (error) {
    console.error('Error getting customer metafield:', error);
    // Return empty array if customer not found or metafield doesn't exist
    if (error.message.includes('Customer not found')) {
      return [];
    }
    throw error;
  }
}

/**
 * POST /api/wishlist/add
 * Add a product to customer's wishlist
 */
router.post('/add', async (req, res) => {
  try {
    const { customerId, productId } = req.body;

    // Additional validation: Check if request is from authorized store
    if (!req.storeValidation?.isValidated) {
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'Request not validated for store access'
      });
    }

    // Validation
    if (!customerId || !productId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'customerId and productId are required'
      });
    }

    

    // Get current wishlist
    let currentWishlist = await getCustomerMetafield(customerId);
    
    // Check if product already exists in wishlist
    const existingProduct = currentWishlist.find(product => product.id === productId);
    if (existingProduct) {
      return res.status(409).json({
        error: 'Product already in wishlist',
        message: 'This product is already in the customer\'s wishlist'
      });
    }

    // Get product details for the new product
    const productDetails = await getProductDetails([productId]);
    const newProduct = {
      ...productDetails[0],
      addedAt: new Date().toISOString(),
      addedFrom: 'shopify-store'
    };

    // Add product to wishlist array
    currentWishlist.push(newProduct);
    
    // Update the entire metafield with the new array
    await updateCustomerMetafield(customerId, currentWishlist);

    res.status(201).json({
      success: true,
      message: 'Product added to wishlist successfully',
      data: {
        customerId,
        product: newProduct,
        wishlistCount: currentWishlist.length
      }
    });

  } catch (error) {
    console.error('Error adding to wishlist:', error);
    res.status(500).json({
      error: 'Failed to add product to wishlist',
      message: error.message
    });
  }
});

/**
 * GET /api/wishlist?customerId=<id>
 * Get customer's wishlist
 */
router.get('/', async (req, res) => {
  try {
    const { customerId } = req.query;

    // Additional validation: Check if request is from authorized store
    if (!req.storeValidation?.isValidated) {
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'Request not validated for store access'
      });
    }

    // Validation
    if (!customerId) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'customerId is required'
      });
    }

    // Log the validated request
    console.log('Authorized wishlist get request:');

    // Get customer's wishlist
    const wishlist = await getCustomerMetafield(customerId);

    res.status(200).json({
      success: true,
      data: {
        customerId,
        wishlist,
        count: wishlist.length
      }
    });

  } catch (error) {
    console.error('Error fetching wishlist:', error);
    res.status(500).json({
      error: 'Failed to fetch wishlist',
      message: error.message
    });
  }
});

/**
 * DELETE /api/wishlist/remove
 * Remove a product from customer's wishlist
 */
router.delete('/remove', async (req, res) => {
  try {
    const { customerId, productId } = req.body;

    // Validation
    if (!customerId || !productId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'customerId and productId are required'
      });
    }

    // Get current wishlist
    let currentWishlist = await getCustomerMetafield(customerId);
    
    // Find and remove the product
    const initialLength = currentWishlist.length;
    currentWishlist = currentWishlist.filter(product => product.id !== productId);
    
    if (currentWishlist.length === initialLength) {
      return res.status(404).json({
        error: 'Product not found',
        message: 'Product not found in wishlist'
      });
    }

    // Update the metafield with the modified array
    await updateCustomerMetafield(customerId, currentWishlist);

    res.json({
      success: true,
      message: 'Product removed from wishlist successfully',
      data: {
        customerId,
        productId,
        wishlistCount: currentWishlist.length
      }
    });

  } catch (error) {
    console.error('Error removing from wishlist:', error);
    res.status(500).json({
      error: 'Failed to remove product from wishlist',
      message: error.message
    });
  }
});


module.exports = router;