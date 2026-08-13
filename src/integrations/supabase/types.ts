export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      analysis_results: {
        Row: {
          ai_generated_confidence: number | null
          ai_summary: string | null
          ai_verdict: string | null
          blur_score: number | null
          brightness_score: number | null
          created_at: string
          duplicate_of_upload_id: string | null
          extracted_vehicle_number: string | null
          has_exif_metadata: boolean | null
          id: string
          image_hash: string | null
          image_height: number | null
          image_width: number | null
          is_blurry: boolean | null
          is_duplicate: boolean | null
          is_low_light: boolean | null
          is_screenshot_or_rephoto: boolean | null
          is_tampered_suspected: boolean | null
          overall_confidence: number | null
          processing_ms: number | null
          raw_analysis_json: Json
          risk_band: string | null
          screenshot_confidence: number | null
          tamper_confidence: number | null
          trust_score: number | null
          upload_id: string
          vehicle_number_valid_format: boolean | null
        }
        Insert: {
          ai_generated_confidence?: number | null
          ai_summary?: string | null
          ai_verdict?: string | null
          blur_score?: number | null
          brightness_score?: number | null
          created_at?: string
          duplicate_of_upload_id?: string | null
          extracted_vehicle_number?: string | null
          has_exif_metadata?: boolean | null
          id?: string
          image_hash?: string | null
          image_height?: number | null
          image_width?: number | null
          is_blurry?: boolean | null
          is_duplicate?: boolean | null
          is_low_light?: boolean | null
          is_screenshot_or_rephoto?: boolean | null
          is_tampered_suspected?: boolean | null
          overall_confidence?: number | null
          processing_ms?: number | null
          raw_analysis_json?: Json
          risk_band?: string | null
          screenshot_confidence?: number | null
          tamper_confidence?: number | null
          trust_score?: number | null
          upload_id: string
          vehicle_number_valid_format?: boolean | null
        }
        Update: {
          ai_generated_confidence?: number | null
          ai_summary?: string | null
          ai_verdict?: string | null
          blur_score?: number | null
          brightness_score?: number | null
          created_at?: string
          duplicate_of_upload_id?: string | null
          extracted_vehicle_number?: string | null
          has_exif_metadata?: boolean | null
          id?: string
          image_hash?: string | null
          image_height?: number | null
          image_width?: number | null
          is_blurry?: boolean | null
          is_duplicate?: boolean | null
          is_low_light?: boolean | null
          is_screenshot_or_rephoto?: boolean | null
          is_tampered_suspected?: boolean | null
          overall_confidence?: number | null
          processing_ms?: number | null
          raw_analysis_json?: Json
          risk_band?: string | null
          screenshot_confidence?: number | null
          tamper_confidence?: number | null
          trust_score?: number | null
          upload_id?: string
          vehicle_number_valid_format?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "analysis_results_duplicate_of_upload_id_fkey"
            columns: ["duplicate_of_upload_id"]
            isOneToOne: false
            referencedRelation: "uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analysis_results_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: true
            referencedRelation: "uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      processing_events: {
        Row: {
          created_at: string
          duration_ms: number | null
          event: string
          id: string
          message: string | null
          upload_id: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          event: string
          id?: string
          message?: string | null
          upload_id: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          event?: string
          id?: string
          message?: string | null
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_events_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      uploads: {
        Row: {
          created_at: string
          failure_reason: string | null
          file_path: string
          file_size_bytes: number
          id: string
          mime_type: string
          original_filename: string
          retry_count: number
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          failure_reason?: string | null
          file_path: string
          file_size_bytes: number
          id?: string
          mime_type: string
          original_filename: string
          retry_count?: number
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          failure_reason?: string | null
          file_path?: string
          file_size_bytes?: number
          id?: string
          mime_type?: string
          original_filename?: string
          retry_count?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
