"""
File Handler
=============
Handles file uploads, storage, and cleanup for CV files.
Optimized for Serverbyt shared hosting.
"""

import os
import uuid
import shutil
import time
import logging
from pathlib import Path
from typing import Optional, Tuple
from datetime import datetime

from app.config import settings

logger = logging.getLogger(__name__)


class FileManager:
    """
    Manages file storage for CV uploads.
    Handles saving, organizing, and cleaning up files.
    """
    
    def __init__(self):
        # Base directory for file storage
        self.base_dir = Path(settings.upload_dir)
        self.cv_dir = self.base_dir / "cv_uploads"
        self.temp_dir = self.base_dir / "temp"
        
        # Create directories if they don't exist
        self.cv_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        
        # Maximum file size in bytes
        self.max_file_size = settings.max_file_size_mb * 1024 * 1024
        
        # Allowed file extensions
        self.allowed_extensions = {'.pdf', '.doc', '.docx', '.txt', '.rtf'}
    
    def save_cv(
        self,
        file_content: bytes,
        original_filename: str,
        phone_number: str
    ) -> Tuple[str, str]:
        """
        Save a CV file with a unique name.
        
        Args:
            file_content: File content as bytes
            original_filename: Original filename from upload
            phone_number: Candidate's phone number for organization
            
        Returns:
            Tuple of (file_path, unique_filename)
        """
        # Validate file size
        if len(file_content) > self.max_file_size:
            raise ValueError(
                f"File too large. Maximum size is {settings.max_file_size_mb}MB"
            )
        
        # Get file extension
        ext = Path(original_filename).suffix.lower()
        if ext not in self.allowed_extensions:
            raise ValueError(
                f"Invalid file type. Allowed types: {', '.join(self.allowed_extensions)}"
            )
        
        # Create unique filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_id = str(uuid.uuid4())[:8]
        safe_phone = phone_number.replace("+", "").replace(" ", "")
        unique_filename = f"{safe_phone}_{timestamp}_{unique_id}{ext}"
        
        # Create subdirectory by date for organization
        date_dir = self.cv_dir / datetime.now().strftime("%Y-%m")
        date_dir.mkdir(parents=True, exist_ok=True)
        
        # Full file path
        file_path = date_dir / unique_filename
        
        # Save file
        try:
            with open(file_path, 'wb') as f:
                f.write(file_content)
            
            logger.info(f"Saved CV file: {file_path}")
            return str(file_path), unique_filename
            
        except Exception as e:
            logger.error(f"Failed to save CV file: {e}")
            raise
    
    def save_temp_file(
        self,
        file_content: bytes,
        filename: str
    ) -> str:
        """
        Save a temporary file for processing.
        
        Args:
            file_content: File content as bytes
            filename: Filename to use
            
        Returns:
            Path to the saved file
        """
        unique_filename = f"{uuid.uuid4()}_{filename}"
        file_path = self.temp_dir / unique_filename
        
        with open(file_path, 'wb') as f:
            f.write(file_content)
        
        return str(file_path)
    
    def get_file_path(self, filename: str) -> Optional[str]:
        """
        Get the full path for a stored file.
        
        Args:
            filename: The stored filename
            
        Returns:
            Full path if found, None otherwise
        """
        # Search in CV directory
        for file_path in self.cv_dir.rglob(filename):
            if file_path.is_file():
                return str(file_path)
        
        return None
    
    def delete_file(self, file_path: str) -> bool:
        """
        Delete a file.
        
        Args:
            file_path: Path to the file to delete
            
        Returns:
            True if deleted, False otherwise
        """
        try:
            path = Path(file_path)
            if path.exists() and path.is_file():
                path.unlink()
                logger.info(f"Deleted file: {file_path}")
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to delete file {file_path}: {e}")
            return False
    
    def cleanup_temp_files(self, max_age_hours: int = 24) -> int:
        """
        Clean up old temporary files.
        
        Args:
            max_age_hours: Maximum age in hours before deletion
            
        Returns:
            Number of files deleted
        """
        current_time = time.time()
        deleted_count = 0
        max_age_seconds = max_age_hours * 3600
        
        try:
            for file_path in self.temp_dir.glob("*"):
                if file_path.is_file():
                    file_age = current_time - file_path.stat().st_mtime
                    if file_age > max_age_seconds:
                        file_path.unlink()
                        deleted_count += 1
            
            if deleted_count > 0:
                logger.info(f"Cleaned up {deleted_count} temporary files")
            
            return deleted_count
            
        except Exception as e:
            logger.error(f"Error during temp file cleanup: {e}")
            return deleted_count
    
    def cleanup_old_files(self, days_old: int = 30) -> int:
        """
        Remove old CV files to save space.
        
        Args:
            days_old: Files older than this many days will be deleted
            
        Returns:
            Number of files deleted
        """
        current_time = time.time()
        deleted_count = 0
        max_age_seconds = days_old * 86400
        
        try:
            for file_path in self.base_dir.rglob("*"):
                if file_path.is_file():
                    file_age = current_time - file_path.stat().st_mtime
                    if file_age > max_age_seconds:
                        file_path.unlink()
                        deleted_count += 1
            
            if deleted_count > 0:
                logger.info(f"Cleaned up {deleted_count} old files")
            
            return deleted_count
            
        except Exception as e:
            logger.error(f"Error during old file cleanup: {e}")
            return deleted_count
    
    def get_storage_stats(self) -> dict:
        """
        Get storage statistics.
        
        Returns:
            Dictionary with storage stats
        """
        total_size = 0
        file_count = 0
        
        for file_path in self.base_dir.rglob("*"):
            if file_path.is_file():
                total_size += file_path.stat().st_size
                file_count += 1
        
        return {
            "total_files": file_count,
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "cv_directory": str(self.cv_dir),
            "temp_directory": str(self.temp_dir)
        }


# Singleton instance
file_manager = FileManager()
