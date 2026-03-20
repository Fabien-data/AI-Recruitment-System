"""
Hybrid Cache
============
Caching implementation that uses Redis if available,
falls back to in-memory LRU cache for shared hosting.
"""

import json
import logging
from typing import Optional, Any
from functools import lru_cache
import time

from app.config import settings

logger = logging.getLogger(__name__)


class HybridCache:
    """
    Hybrid caching solution that uses Redis when available,
    falls back to local dictionary cache otherwise.
    """
    
    def __init__(self):
        self.use_redis = False
        self.redis_client = None
        self.local_cache = {}
        self.cache_timestamps = {}
        
        # Try to connect to Redis
        if settings.redis_url:
            try:
                import redis
                self.redis_client = redis.from_url(
                    settings.redis_url,
                    decode_responses=True
                )
                # Test connection
                self.redis_client.ping()
                self.use_redis = True
                logger.info("Redis cache connected successfully")
            except Exception as e:
                logger.warning(f"Redis not available, using local cache: {e}")
                self.use_redis = False
    
    def get(self, key: str) -> Optional[str]:
        """
        Get a value from cache.
        
        Args:
            key: Cache key
            
        Returns:
            Cached value or None
        """
        try:
            if self.use_redis:
                return self.redis_client.get(key)
            else:
                # Check if key exists and not expired
                if key in self.local_cache:
                    timestamp = self.cache_timestamps.get(key, 0)
                    if time.time() - timestamp < 3600:  # Default 1 hour TTL
                        return self.local_cache[key]
                    else:
                        # Expired, remove it
                        del self.local_cache[key]
                        del self.cache_timestamps[key]
                return None
        except Exception as e:
            logger.error(f"Cache get error for key {key}: {e}")
            return None
    
    def set(self, key: str, value: str, ttl: int = 3600) -> bool:
        """
        Set a value in cache.
        
        Args:
            key: Cache key
            value: Value to cache
            ttl: Time to live in seconds
            
        Returns:
            True if successful
        """
        try:
            if self.use_redis:
                self.redis_client.setex(key, ttl, value)
            else:
                self.local_cache[key] = value
                self.cache_timestamps[key] = time.time()
            return True
        except Exception as e:
            logger.error(f"Cache set error for key {key}: {e}")
            return False
    
    def delete(self, key: str) -> bool:
        """
        Delete a value from cache.
        
        Args:
            key: Cache key
            
        Returns:
            True if successful
        """
        try:
            if self.use_redis:
                self.redis_client.delete(key)
            else:
                self.local_cache.pop(key, None)
                self.cache_timestamps.pop(key, None)
            return True
        except Exception as e:
            logger.error(f"Cache delete error for key {key}: {e}")
            return False
    
    def get_json(self, key: str) -> Optional[Any]:
        """
        Get and parse JSON value from cache.
        
        Args:
            key: Cache key
            
        Returns:
            Parsed JSON or None
        """
        value = self.get(key)
        if value:
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return None
        return None
    
    def set_json(self, key: str, value: Any, ttl: int = 3600) -> bool:
        """
        JSON-encode and set a value in cache.
        
        Args:
            key: Cache key
            value: Value to cache (will be JSON-encoded)
            ttl: Time to live in seconds
            
        Returns:
            True if successful
        """
        try:
            json_value = json.dumps(value)
            return self.set(key, json_value, ttl)
        except (TypeError, json.JSONEncodeError):
            logger.error(f"Failed to JSON-encode value for key {key}")
            return False
    
    def clear_local_cache(self) -> None:
        """Clear the local cache (useful for memory management)."""
        self.local_cache.clear()
        self.cache_timestamps.clear()
        logger.info("Local cache cleared")
    
    def get_stats(self) -> dict:
        """
        Get cache statistics.
        
        Returns:
            Dictionary with cache stats
        """
        stats = {
            "backend": "redis" if self.use_redis else "local",
            "local_cache_size": len(self.local_cache)
        }
        
        if self.use_redis:
            try:
                info = self.redis_client.info("memory")
                stats["redis_memory_used"] = info.get("used_memory_human", "unknown")
            except Exception:
                pass
        
        return stats


# Singleton instance
cache = HybridCache()


# Convenience functions for common caching patterns

def cache_conversation_context(phone_number: str, context: str, ttl: int = 1800) -> bool:
    """Cache conversation context for a user (30 min default)."""
    key = f"conv_context:{phone_number}"
    return cache.set(key, context, ttl)


def get_cached_conversation_context(phone_number: str) -> Optional[str]:
    """Get cached conversation context for a user."""
    key = f"conv_context:{phone_number}"
    return cache.get(key)


def cache_candidate_state(phone_number: str, state: dict, ttl: int = 3600) -> bool:
    """Cache candidate conversation state."""
    key = f"candidate_state:{phone_number}"
    return cache.set_json(key, state, ttl)


def get_cached_candidate_state(phone_number: str) -> Optional[dict]:
    """Get cached candidate state."""
    key = f"candidate_state:{phone_number}"
    return cache.get_json(key)
