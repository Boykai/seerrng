interface TadbArtist {
  idArtist?: string;
  strMusicBrainzID?: string;
  strBiography?: string | null;
  strBiographyEN?: string | null;
  strArtistThumb: string | null;
  strArtistFanart: string | null;
}

export interface TadbAlbumResponse {
  album?:
    | {
        idAlbum?: string;
        strMusicBrainzID?: string;
        intScore?: string | null;
        intScoreVotes?: string | null;
      }[]
    | null;
}

export interface TadbArtistResponse {
  artists?: TadbArtist[];
}
